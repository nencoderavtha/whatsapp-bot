import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { buildSystemPrompt } from "./prompt.js";
import { getOrCreateCustomer, logMessage, recentMessages } from "../services/customer.js";
import { getEnabledTools, runTool } from "./tools.js";
import { completeChat } from "./llm.js";
import { prisma } from "../db.js";
import { fallbackTemplate } from "./templates.js";
import { logActivity } from "../services/activity.js";

export interface AgentResult {
  reply: string;
  placedOrderId?: number;
  humanHandoffRequested?: boolean;
}

const customerLocks = new Map<string, Promise<void>>();

function withCustomerLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = customerLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const myLock = new Promise<void>((res) => { release = res; });
  customerLocks.set(key, myLock);

  return prev
    .then(() => fn())
    .finally(() => {
      release();
      if (customerLocks.get(key) === myLock) customerLocks.delete(key);
    });
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

  const checkHistory = await recentMessages(customer.id, 5);
  const isGreeting = ["hi", "hello", "hey", "namaste", "start", "menu", "yo", "hola", "namaskar", "namaskaram"].includes(userText.trim().toLowerCase());
  
  let shouldReset = false;
  if (checkHistory.length > 0) {
    const lastMsg = checkHistory[checkHistory.length - 1];
    const diffMs = new Date().getTime() - new Date(lastMsg.createdAt).getTime();
    const isOld = diffMs > 15 * 60 * 1000;

    const hasConfirmedInHistory = checkHistory.some(m => {
      if (m.role !== "assistant") return false;
      const content = m.content.toLowerCase();
      return (
        content.includes("order confirmed") ||
        content.includes("confirmed!") ||
        content.includes("being prepared") ||
        content.includes("ready in")
      );
    });

    if (isGreeting || isOld || hasConfirmedInHistory) {
      shouldReset = true;
    }
  }

  if (shouldReset) {
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { customerId: customer.id } }),
      prisma.pendingOrder.deleteMany({ where: { customerId: customer.id } }),
    ]);
  }

  await logMessage(customer.id, "user", userText);

  const history = await recentMessages(customer.id, 6);
  const isFirstMessage = history.length === 1;

  const [system, tools] = await Promise.all([
    buildSystemPrompt(customer.name ?? undefined, restaurantId, isFirstMessage, customer.id),
    getEnabledTools(restaurantId),
  ]);

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
  let finalText = "";

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

      console.log(`[agent] → tool: ${tc.function.name}  args: ${JSON.stringify(args)}`);
      const { output, orderId, templateReply: tr, humanHandoff } = await runTool(customer.id, restaurantId, tc.function.name, args);
      console.log(`[agent] ← ${tc.function.name}:`, JSON.stringify(output).slice(0, 300));
      if (orderId) placedOrderId = orderId;
      if (humanHandoff) humanHandoffRequested = true;
      if (tr) templateReply = tr;

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

  await logMessage(customer.id, "assistant", finalText);
  return { reply: finalText, placedOrderId, humanHandoffRequested };
}

export async function handleIncoming(
  phone: string,
  userText: string,
  restaurantId: number,
): Promise<AgentResult> {
  const lockKey = `${restaurantId}:${phone}`;
  return withCustomerLock(lockKey, () => processIncoming(phone, userText, restaurantId));
}
