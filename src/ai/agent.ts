import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { config } from "../config.js";
import { systemPrompt } from "./prompt.js";
import { menuAsText } from "../services/menu.js";
import {
  getOrCreateCustomer,
  updateCustomer,
  logMessage,
  recentMessages,
} from "../services/customer.js";
import { createOrder, findRecentDuplicate, getOrder } from "../services/order.js";
import { prisma } from "../db.js";

// One OpenAI-compatible client, pointed at Groq or Cerebras per config.
// maxRetries: 0 — we do our own retry/backoff in completeWithRetry below.
const client = new OpenAI({
  apiKey: config.aiApiKey,
  baseURL: config.aiBaseURL,
  maxRetries: 0,
});

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "propose_order",
      description:
        "Calculate and stage the order so you can read back the items + total to the customer. This does NOT place the order yet — call it once you know all the items, quantities, and pickup/delivery. Returns the validated items and total to confirm with the customer.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "Line items the customer asked for",
            items: {
              type: "object",
              properties: {
                menuItemId: { type: "number" },
                qty: { type: "number" },
                note: { type: "string", description: "Special request for this item, optional" },
              },
              required: ["menuItemId", "qty"],
            },
          },
          type: { type: "string", enum: ["pickup", "delivery", "dine-in"] },
          note: { type: "string", description: "Overall order note, optional" },
        },
        required: ["items", "type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_order",
      description:
        "Actually place the order that was staged with propose_order. Call this ONLY after the customer has clearly said yes/confirm to the read-back. Takes no arguments — it places exactly what was proposed. Safe to be called only after a proposal exists.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "save_customer_info",
      description:
        "Remember the customer's name, address, or notes (preferences/allergies) for future orders.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          address: { type: "string" },
          notes: { type: "string" },
        },
      },
    },
  },
];

export interface AgentResult {
  reply: string;
  placedOrderId?: number;
}

// Server-side staged cart per customer. confirm_order persists THIS, not whatever
// the model passes — so the model cannot fabricate or alter the order at confirm time.
interface PendingCart {
  lines: { menuItemId: number; qty: number; note?: string }[];
  type: string;
  note?: string;
  confirmedOrderId?: number; // set once placed → makes confirm idempotent
}
const pendingCarts = new Map<number, PendingCart>();

/**
 * Call Groq, retrying on:
 *  - 429 rate-limit errors (free tier has per-minute caps), with backoff.
 *  - `tool_use_failed` 400s — Llama models on Groq occasionally emit a malformed
 *    tool call; since generation is stochastic, an immediate retry almost always fixes it.
 */
async function completeWithRetry(
  params: ChatCompletionCreateParamsNonStreaming,
  maxRetries = 3,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.chat.completions.create(params);
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      const msg = String(e?.message ?? e);
      const code = e?.error?.error?.code ?? e?.error?.code;

      const is429 = status === 429 || msg.includes("rate_limit") || msg.includes("429");
      const isBadToolCall = code === "tool_use_failed" || msg.includes("tool_use_failed");

      if ((!is429 && !isBadToolCall) || attempt >= maxRetries) throw e;

      if (is429) {
        // Respect Groq's guidance: don't retry if it says not to, or if the wait is long
        // (e.g. a daily-token-limit reset of many minutes — retrying just wastes time).
        const shouldRetry = (e?.headers?.get?.("x-should-retry") ?? "") !== "false";
        const retryAfter = Number(e?.headers?.get?.("retry-after"));
        const waitS = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5 * (attempt + 1);
        if (!shouldRetry || waitS > 30) throw e;
        console.warn(`⏳ Rate-limited, retrying in ${waitS}s...`);
        await new Promise((r) => setTimeout(r, waitS * 1000));
      } else {
        console.warn("↻ Malformed tool call from model, retrying...");
      }
    }
  }
}

/**
 * Run one turn of the conversation for a given WhatsApp phone number.
 * Loads memory, calls Groq with tools, executes tools, persists everything.
 */
export async function handleIncoming(
  phone: string,
  userText: string,
): Promise<AgentResult> {
  const customer = await getOrCreateCustomer(phone);
  await logMessage(customer.id, "user", userText);

  const history = await recentMessages(customer.id, 10);
  const menuText = await menuAsText();
  const system = systemPrompt(menuText, customer.name ?? undefined);

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
  let finalText = "";

  // Tool loop: keep going until the model stops requesting tool calls.
  for (let hop = 0; hop < 6; hop++) {
    const res = await completeWithRetry({
      model: config.aiModel,
      messages,
      tools,
      temperature: 0.8,
      max_tokens: 700,
    });

    const msg = res.choices[0]?.message;
    if (!msg) break;
    if (msg.content) finalText = msg.content.trim();

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) break;

    // Push the assistant turn (with tool_calls) then each tool result.
    messages.push(msg);
    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {}
      const { output, orderId } = await runTool(customer.id, tc.function.name, args);
      if (orderId) placedOrderId = orderId;
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(output),
      });
    }
  }

  if (!finalText) finalText = "Sorry anna, oka sari malli cheppara? 🙏";
  await logMessage(customer.id, "assistant", finalText);
  return { reply: finalText, placedOrderId };
}

async function runTool(
  customerId: number,
  name: string,
  args: Record<string, any>,
): Promise<{ output: unknown; orderId?: number }> {
  try {
    switch (name) {
      case "save_customer_info": {
        const c = await prisma.customer.findUnique({ where: { id: customerId } });
        if (c) {
          await updateCustomer(c.phone, {
            name: args.name,
            address: args.address,
            notes: args.notes,
          });
        }
        return { output: { ok: true } };
      }
      case "propose_order": {
        const rawLines = (args.items ?? []).map((l: any) => ({
          menuItemId: Number(l.menuItemId),
          qty: Math.max(1, Number(l.qty ?? 1)),
          note: l.note,
        }));
        // Validate every item against the live menu; reject unknown/unavailable ones.
        const menuItems = await prisma.menuItem.findMany({
          where: { id: { in: rawLines.map((l: any) => l.menuItemId) } },
        });
        const byId = new Map(menuItems.map((m) => [m.id, m]));
        const valid = rawLines.filter((l: any) => byId.get(l.menuItemId)?.available);
        const rejected = rawLines.filter((l: any) => !byId.get(l.menuItemId)?.available);
        if (valid.length === 0) {
          return {
            output: {
              ok: false,
              error: "None of those items are on the live menu / available. Ask the customer to pick from the menu — do NOT substitute on your own.",
            },
          };
        }
        const total = valid.reduce(
          (sum: number, l: any) => sum + byId.get(l.menuItemId)!.price * l.qty,
          0,
        );
        pendingCarts.set(customerId, {
          lines: valid,
          type: args.type ?? "pickup",
          note: args.note,
        });
        return {
          output: {
            ok: true,
            staged: true,
            type: args.type ?? "pickup",
            items: valid.map((l: any) => {
              const mi = byId.get(l.menuItemId)!;
              return `${l.qty}x ${mi.name} (₹${mi.price})`;
            }),
            total,
            rejected: rejected.length
              ? rejected.map((l: any) => byId.get(l.menuItemId)?.name ?? `#${l.menuItemId}`)
              : undefined,
            note: "Read this total back to the customer and ask them to confirm. Do NOT call confirm_order until they clearly say yes.",
          },
        };
      }
      case "confirm_order": {
        const cart = pendingCarts.get(customerId);
        if (!cart) {
          return {
            output: {
              ok: false,
              error: "No order is staged yet. Use propose_order first after gathering the items.",
            },
          };
        }
        // Idempotent: if already confirmed, return the same order; never create twice.
        if (cart.confirmedOrderId) {
          const existing = await getOrder(cart.confirmedOrderId);
          return {
            output: {
              ok: true,
              alreadyPlaced: true,
              orderId: cart.confirmedOrderId,
              total: existing?.total,
              note: "Already placed — just reassure the customer with this order number. Do NOT place again.",
            },
          };
        }
        // Second safety net against duplicates from a near-identical recent order.
        const dup = await findRecentDuplicate(customerId, cart.lines);
        if (dup) {
          cart.confirmedOrderId = dup.id;
          return {
            output: { ok: true, alreadyPlaced: true, orderId: dup.id, total: dup.total },
          };
        }
        const order = await createOrder({
          customerId,
          type: cart.type,
          note: cart.note,
          lines: cart.lines,
        });
        cart.confirmedOrderId = order.id;
        return {
          output: {
            ok: true,
            orderId: order.id,
            total: order.total,
            items: order.items.map((i) => `${i.qty}x ${i.nameSnap}`),
          },
          orderId: order.id, // triggers owner notification
        };
      }
      default:
        return { output: { error: `Unknown tool ${name}` } };
    }
  } catch (e: any) {
    return { output: { error: e?.message ?? String(e) } };
  }
}
