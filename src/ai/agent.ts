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

export interface AgentResult {
  reply: string;
  placedOrderId?: number;
  humanHandoffRequested?: boolean;
  mediaReply?: { imageUrl: string; caption?: string };
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
  // Address and payment-method button ids are deliberately absent. Rewriting a
  // tap into prose sent the model off to compose its own reply — which is how a
  // customer asking about their address got told they had none, and how the
  // address loop formed. Those ids are handled deterministically before the
  // agent is reached; anything still arriving here is genuine free text.

  // Retire a cart that is genuinely finished — settled, or past its TTL. The
  // decision comes from the stage on the row, not from what the conversation
  // looks like.
  //
  // What used to be here read the last five messages and wiped every message
  // *and* the pending cart if the customer said "menu", if fifteen minutes had
  // passed, or if any assistant reply contained "order confirmed" / "ready in".
  // All three misfire on a live order: the bot says "ready in 30 mins" while a
  // cart is still being built, and the cart — address, quote, payment link —
  // vanishes mid-order. That is the workflow restart this platform is not
  // allowed to do. Staleness is now handled where it belongs, by trimming the
  // model's context window rather than deleting the customer's history.
  await clearFinishedCart(customer.id);

  await logMessage(customer.id, "user", userText);

  const history = await conversationWindow(customer.id, 6);
  const isFirstMessage = history.length === 1;

  const [system, tools, menuText] = await Promise.all([
    buildSystemPrompt(customer.name ?? undefined, restaurantId, isFirstMessage, customer.id),
    getEnabledTools(restaurantId),
    menuAsText(restaurantId),
  ]);

  const intentPromise = classifyIntent(
    history.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    userText,
    menuText
  );

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...history.map(
      (m): ChatCompletionMessageParam => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }),
    ),
  ];

  let placedOrderId: number | undefined;
  let humanHandoffRequested = false;
  let templateReply: string | undefined;
  let mediaReply: { imageUrl: string; caption?: string } | undefined;
  let finalText = "";
  const executedTools: string[] = [];

  const startedAt = Date.now();

  for (let hop = 0; hop < 6; hop++) {
    const { content, toolCalls } = await completeChat({
      messages,
      tools,
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
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }

      logger.info(`[agent] → tool: ${tc.function.name}  args: ${JSON.stringify(args)}`);
      executedTools.push(tc.function.name);
      const { output, orderId, templateReply: tr, humanHandoff, mediaReply: mr } = await runTool(customer.id, restaurantId, tc.function.name, args);
      logger.info(`[agent] ← ${tc.function.name}:`, JSON.stringify(output).slice(0, 300));
      if (orderId) placedOrderId = orderId;
      if (humanHandoff) humanHandoffRequested = true;
      if (tr) templateReply = tr;
      if (mr) mediaReply = mr;

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(output),
      } as any);
    }

    if (templateReply) break;
  }

  const usedFallback = !templateReply && !finalText;
  if (finalText) finalText = fixLeadingAndi(finalText);
  finalText = templateReply ?? (finalText || fallbackTemplate());

  const elapsedMs = Date.now() - startedAt;
  void logActivity(restaurantId, "response_time", `Reply in ${elapsedMs}ms`, { elapsedMs }, customer.id);
  if (usedFallback) {
    void logActivity(restaurantId, "fallback", `Fell back to generic reply for: ${userText.slice(0, 80)}`, undefined, customer.id);
  }

  try {
    const intentResult = await intentPromise;
    void logActivity(
      restaurantId,
      "intent_shadow",
      `Intent: ${intentResult.intent} vs Tools: ${executedTools.length ? executedTools.join(", ") : "none"}`,
      { intent: intentResult, executedTools, userText },
      customer.id
    );
  } catch (e) {
    logger.error("[agent] Intent classification failed:", e);
  }

  await logMessage(customer.id, "assistant", finalText);
  return { reply: finalText, placedOrderId, humanHandoffRequested };
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
