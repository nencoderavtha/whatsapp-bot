import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { buildSystemPrompt } from "./prompt.js";
import { getOrCreateCustomer, logMessage, recentMessages } from "../services/customer.js";
import { getEnabledTools, runTool } from "./tools.js";
import { completeChat } from "./llm.js";
import { prisma } from "../db.js";

export interface AgentResult {
  reply: string;
  placedOrderId?: number;
}

// ---------------------------------------------------------------------------
// Per-customer async lock — only one message per customer processed at a time.
// Prevents race conditions when two messages arrive milliseconds apart.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

function looksLikeToolGarbage(s: string): boolean {
  const c = s.trim();
  // Catch raw JSON tool-call blobs the model sometimes leaks as text
  return (
    (c.startsWith("{") && c.includes('"name"')) ||
    (c.startsWith("{") && c.includes('"function"')) ||
    c.startsWith('{"tool') ||
    c.includes('"tool_calls"') ||
    c.includes('"tool_call_id"')
  );
}

async function processIncoming(
  phone: string,
  userText: string,
  restaurantId: number,
): Promise<AgentResult> {
  const customer = await getOrCreateCustomer(phone, restaurantId);

  // Transform native WhatsApp interactive button/list row selections into natural intent
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
  } else if (userText === "pay_method_upi") {
    userText = "I want to pay via UPI";
  } else if (userText === "pay_method_razorpay") {
    userText = "I want to pay online via Razorpay";
  } else if (userText === "pay_method_cash") {
    userText = "I want to pay cash on delivery or at counter";
  } else if (userText === "confirm_order_btn") {
    userText = "Yes, confirm my order";
  } else if (userText === "add_more_items_btn") {
    userText = "I want to add more items to my order";
  } else if (userText === "use_saved_address") {
    userText = "Please use my saved delivery address";
  } else if (userText === "change_address") {
    userText = "I want to update my delivery address";
  }

  // Clean up and reset session if last messages contain order confirmations or if the history is old.
  const checkHistory = await recentMessages(customer.id, 5);
  const isGreeting = ["hi", "hello", "hey", "namaste", "start", "menu", "yo", "hola", "namaskar", "namaskaram"].includes(userText.trim().toLowerCase());
  
  let shouldReset = false;
  if (checkHistory.length > 0) {
    const lastMsg = checkHistory[checkHistory.length - 1];
    const diffMs = new Date().getTime() - new Date(lastMsg.createdAt).getTime();
    const isOld = diffMs > 15 * 60 * 1000; // 15 minutes

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

  await logMessage(customer.id, restaurantId, "user", userText);

  // Load up to 6 recent messages for fast context
  const history = await recentMessages(customer.id, 6);

  // First message = only the current user message exists in history
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
  let templateReply: string | undefined;
  let finalText = "";

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

    // Must include tool_calls in the assistant turn so the model sees what it called
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
      const { output, orderId, templateReply: tr } = await runTool(customer.id, restaurantId, tc.function.name, args);
      console.log(`[agent] ← ${tc.function.name}:`, JSON.stringify(output).slice(0, 300));
      if (orderId) placedOrderId = orderId;
      if (tr) templateReply = tr; // last tool with a template wins

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(output),
      } as any);
    }

    if (templateReply) break; // Instant exit! Tool produced template reply — zero 2nd LLM roundtrip delay!
  }

  finalText = templateReply ?? (finalText || "Sorry, please try again in a moment.");

  await logMessage(customer.id, restaurantId, "assistant", finalText);
  return { reply: finalText, placedOrderId };
}

// Public entry point — serialises concurrent messages from the same customer.
export async function handleIncoming(
  phone: string,
  userText: string,
  restaurantId: number,
): Promise<AgentResult> {
  const lockKey = `${restaurantId}:${phone}`;
  return withCustomerLock(lockKey, () => processIncoming(phone, userText, restaurantId));
}
