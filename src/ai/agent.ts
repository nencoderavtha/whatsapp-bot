import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { buildSystemPrompt } from "./prompt.js";
import { getOrCreateCustomer, logMessage, conversationWindow } from "../services/customer.js";
import { getEnabledTools, runTool } from "./tools.js";
import { completeChat } from "./llm.js";
import { prisma } from "../db.js";
import { fallbackTemplate } from "./templates.js";
import { logActivity } from "../services/activity.js";
import { acquire, enqueue, drain } from "../services/conversation-lock.js";
import { clearFinishedCart } from "../whatsapp/stage.js";
import { logger } from '../services/logger.js';
import { menuAsText } from "../services/menu.js";
import { classifyIntent } from "./intent.js";
import { missingSlots } from "../orchestrator/slots.js";
import { nextAction } from "../orchestrator/transitions.js";

/**
 * UI the backend must render for this turn.
 *
 * The agent names what should happen; the session manager owns how it looks and
 * which WhatsApp primitive carries it. Branches here used to answer with
 * hardcoded prose instead — telling customers to type "Deliver to 123 Main St"
 * when the whole flow is built around a pinned location, or to "use the link
 * provided previously" without resending it.
 */
export type RenderAction =
  | { type: "address_picker" }
  | { type: "billing" }
  | { type: "resend_payment_link" };

export interface AgentResult {
  reply: string;
  placedOrderId?: number;
  humanHandoffRequested?: boolean;
  mediaReply?: { imageUrl: string; caption?: string };
  renderAction?: RenderAction;
}

function looksLikeToolGarbage(s: string): boolean {
  const c = s.trim();
  return (
    (c.startsWith("{") && c.includes('"name"')) ||
    (c.startsWith("{") && c.includes('"function"')) ||
    c.startsWith('{"tool') ||
    c.includes('"tool_calls"') ||
    c.includes('"tool_call_id"')
  );
}

function fixLeadingAndi(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*)andi[,\s]+(.*)$/i);
      if (!m) return line;
      const [, lead, rest] = m;
      if (!rest) return line;
      return lead + rest.charAt(0).toUpperCase() + rest.slice(1);
    })
    .join("\n");
}

async function processIncoming(
  phone: string,
  userText: string,
  restaurantId: number,
): Promise<AgentResult> {
  const customer = await getOrCreateCustomer(phone, restaurantId);

  if (userText.startsWith("menu_item_")) {
    const itemId = parseInt(userText.replace("menu_item_", ""), 10);
    if (!isNaN(itemId)) {
      const item = await prisma.menuItem.findUnique({
        where: { id: itemId },
        include: { variants: true },
      });
      if (item) {
        userText = `I want to order 1 ${item.name}`;
      }
    }
  } else if (userText === "confirm_order_btn") {
    userText = "Yes, confirm my order";
  } else if (userText === "add_more_items_btn") {
    userText = "I want to add more items to my order";
  }

  await clearFinishedCart(customer.id);
  await logMessage(customer.id, "user", userText);

  const history = await conversationWindow(customer.id, 6);
  const isFirstMessage = history.length === 1;

  const [system, tools, menuText, draft] = await Promise.all([
    buildSystemPrompt(customer.name ?? undefined, restaurantId, isFirstMessage, customer.id),
    getEnabledTools(restaurantId),
    menuAsText(restaurantId),
    prisma.pendingOrder.findUnique({ where: { customerId: customer.id } }),
  ]);

  const intentResult = await classifyIntent(
    history.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    userText,
    menuText
  );

  const missing = missingSlots(draft, customer);
  const action = nextAction(draft?.stage ?? "BUILDING_CART", intentResult, missing);

  let placedOrderId: number | undefined;
  let humanHandoffRequested = false;
  let templateReply: string | undefined;
  let mediaReply: { imageUrl: string; caption?: string } | undefined;
  let renderAction: RenderAction | undefined;
  let finalText = "";
  const executedTools: string[] = [];

  const startedAt = Date.now();

  try {
    void logActivity(
      restaurantId,
      "intent_shadow", // keep same log type for continuity
      `Intent: ${intentResult.intent} -> Action: ${action.kind} (${action.kind === "mutate" ? action.op : action.kind === "render" ? action.type : ""})`,
      { intent: intentResult, action, userText },
      customer.id
    );
  } catch (e) {
    logger.error("[agent] Intent classification logging failed:", e);
  }

  if (action.kind === "clarify") {
    finalText = action.text;
  } else if (action.kind === "mutate") {
    let output: any;
    
    if (["add_items", "remove_items", "update_items", "clear_cart"].includes(action.op)) {
      let currentLines: any[] = [];
      if (draft && draft.lines) {
        try { currentLines = JSON.parse(draft.lines); } catch (e) {}
      }

      const deltaItems = action.args?.items || [];
      
      if (action.op === "clear_cart") {
        currentLines = [];
      } else if (action.op === "add_items") {
        for (const item of deltaItems) {
          const ex = currentLines.find((l: any) => l.menuItemId === item.menuItemId && l.variantId === item.variantId);
          if (ex) {
            ex.qty += (item.qty || 1);
          } else {
            currentLines.push({ menuItemId: item.menuItemId, variantId: item.variantId, qty: item.qty || 1, note: item.note });
          }
        }
      } else if (action.op === "remove_items") {
        for (const item of deltaItems) {
          currentLines = currentLines.filter((l: any) => !(l.menuItemId === item.menuItemId && (item.variantId ? l.variantId === item.variantId : true)));
        }
      } else if (action.op === "update_items") {
        for (const item of deltaItems) {
          const ex = currentLines.find((l: any) => l.menuItemId === item.menuItemId && (item.variantId ? l.variantId === item.variantId : true));
          if (ex) {
            ex.qty = item.qty || 1;
            if (item.note) ex.note = item.note;
          }
        }
      }

      executedTools.push("propose_order");
      const res = await runTool(customer.id, restaurantId, "propose_order", { items: currentLines });
      output = res.output;
      templateReply = res.templateReply;
    } 
    else if (action.op === "confirm_order") {
      executedTools.push("confirm_order");
      const res = await runTool(customer.id, restaurantId, "confirm_order", {});
      output = res.output;
      templateReply = res.templateReply;
    }
    else if (action.op === "cancel_order") {
      executedTools.push("cancel_order");
      const res = await runTool(customer.id, restaurantId, "cancel_order", {});
      output = res.output;
      templateReply = res.templateReply;
    }
    else if (action.op === "check_status") {
      executedTools.push("check_order_status");
      const res = await runTool(customer.id, restaurantId, "check_order_status", {});
      output = res.output;
      templateReply = res.templateReply;
    }
    else if (action.op === "request_human") {
      // Route through the real tool. This branch used to set the flag inline and
      // reply with fallbackTemplate() — the "I didn't understand" message — so a
      // customer asking for a manager was told the bot hadn't understood them.
      // Worse, it never set humanRequestedAt, so the AI kept answering while
      // staff replied from the dashboard: two voices in the same chat.
      executedTools.push("request_human_handoff");
      const res = await runTool(customer.id, restaurantId, "request_human_handoff", {
        reason: userText,
      });
      output = res.output;
      templateReply = res.templateReply;
      humanHandoffRequested = res.humanHandoff ?? true;
    }
    else if (action.op === "change_address" || action.op === "select_address") {
      // Was: "Delivery address cheppandi... (e.g., 'Deliver to 123 Main St')".
      // A typed address has no coordinates, so Borzo would quote from a geocoded
      // guess rather than the pin — the saved-address picker is the actual flow.
      renderAction = { type: "address_picker" };
    }
    else if (action.op === "generate_quote") {
      // Previously unhandled, so needing a delivery quote silently abandoned the
      // deterministic path and let the model improvise mid-checkout.
      renderAction = { type: "billing" };
    }
  } else if (action.kind === "render") {
    if (action.type === "request_address") {
      renderAction = { type: "address_picker" };
    } else if (action.type === "request_payment") {
      // Was: "use the link provided previously" — a dead end for anyone who had
      // lost it. Resend the actual link instead.
      renderAction = { type: "resend_payment_link" };
    }
  }

  if (action.kind === "reply_freeform" || (!templateReply && !finalText)) {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      ...history.map(
        (m): ChatCompletionMessageParam => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        }),
      ),
    ];

    for (let hop = 0; hop < 3; hop++) {
      const { content, toolCalls } = await completeChat({
        messages,
        tools: tools,
        temperature: 0.3,
        maxTokens: 400,
      });

      if (!toolCalls.length) {
        if (content && !looksLikeToolGarbage(content)) finalText = content;
        break;
      }

      messages.push({
        role: "assistant",
        content: content ?? null,
        tool_calls: toolCalls as any,
      } as any);

      for (const tc of toolCalls) {
        if (tc.type !== "function") continue;
        let args: Record<string, any> = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}

        logger.info(`[agent] → tool: ${tc.function.name}  args: ${JSON.stringify(args)}`);
        executedTools.push(tc.function.name);
        const { output: o, orderId: oid, templateReply: tr, humanHandoff: hh, mediaReply: mr } = await runTool(customer.id, restaurantId, tc.function.name, args);
        logger.info(`[agent] ← ${tc.function.name}:`, JSON.stringify(o).slice(0, 300));
        
        if (oid) placedOrderId = oid;
        if (hh) humanHandoffRequested = true;
        if (tr) templateReply = tr;
        if (mr) mediaReply = mr;

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(o),
        } as any);
      }

      if (templateReply) break;
    }
  }

  const usedFallback = !templateReply && !finalText;
  if (finalText) finalText = fixLeadingAndi(finalText);
  finalText = templateReply ?? (finalText || fallbackTemplate());

  const elapsedMs = Date.now() - startedAt;
  void logActivity(restaurantId, "response_time", `Reply in ${elapsedMs}ms`, { elapsedMs }, customer.id);
  if (usedFallback) {
    void logActivity(restaurantId, "fallback", `Fell back to generic reply for: ${userText.slice(0, 80)}`, undefined, customer.id);
  }

  // A render action carries the whole reply, so don't also emit fallback prose.
  if (renderAction) {
    return { reply: "", placedOrderId, humanHandoffRequested, mediaReply, renderAction };
  }

  await logMessage(customer.id, "assistant", finalText);
  return { reply: finalText, placedOrderId, humanHandoffRequested, mediaReply };
}

/**
 * Coalesce messages a customer sends in quick succession into one turn.
 *
 * People type an order across several lines — "2 biryani", "1 parotta",
 * "deliver to home" — and answering each separately gives three replies and
 * three chances to misread the order.
 *
 * Nothing is delayed to achieve this. A turn already takes ~2.2s at the median,
 * so anything typed during that window is free to absorb: the in-flight reply is
 * discarded and one turn is run over the combined text. A customer who sends a
 * single message waits exactly as long as before — deliberately, since a blanket
 * debounce would have roughly doubled the median response time to fix a case
 * that only affects burst typers.
 *
 * The lock and the queue live in Postgres rather than in this module. Both used
 * to be process-local, which quietly stopped serializing anything the moment
 * Cloud Run ran a second instance: two messages from one customer would land on
 * two instances, both see no lock, and run two agent loops over the same cart.
 */
export async function handleIncoming(
  phone: string,
  userText: string,
  restaurantId: number,
): Promise<AgentResult> {
  const lockKey = `${restaurantId}:${phone}`;

  const lease = await acquire(lockKey);

  // A turn is already running for this customer, here or on another instance.
  // Hand our text to whoever holds the lease and stay silent — that turn
  // delivers one answer covering this message too.
  if (!lease) {
    await enqueue(lockKey, userText);
    console.log(`[agent] Coalescing follow-up for ${lockKey}: "${userText.slice(0, 60)}"`);
    return { reply: "" };
  }

  try {
    // Anything already queued arrived either while a previous holder was working
    // or while it was dying. Either way nobody has answered it, so it is part of
    // this turn.
    const stranded = await drain(lockKey);
    if (stranded.length) {
      console.log(`[agent] Picked up ${stranded.length} unanswered message(s) for ${lockKey}`);
    }
    let text = [...stranded, userText].join("\n");

    for (let round = 0; round < 3; round++) {
      const turnStart = new Date();
      const result = await processIncoming(phone, text, restaurantId);

      const followUps = await drain(lockKey);
      if (!followUps.length) return result;

      // Newer messages landed mid-turn. Drop this reply and answer once over
      // everything the customer actually said. The superseded exchange is
      // removed from history too — otherwise the re-run reads a reply that was
      // never sent, and the combined text would appear twice.
      try {
        const cust = await getOrCreateCustomer(phone, restaurantId);
        await prisma.message.deleteMany({
          where: { customerId: cust.id, createdAt: { gte: turnStart } },
        });
      } catch (e) {
        console.error("[agent] Could not clear superseded turn from history:", e);
      }

      text = [text, ...followUps].join("\n");
      console.log(`[agent] Re-running ${lockKey} over ${followUps.length + 1} combined messages`);
    }

    // Ran out of rounds — someone is typing faster than we can answer. Reply to
    // what we have rather than looping.
    return await processIncoming(phone, text, restaurantId);
  } finally {
    await lease.release();
  }
}
