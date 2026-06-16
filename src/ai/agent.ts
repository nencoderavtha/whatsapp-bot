import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { buildSystemPrompt } from "./prompt.js";
import { greetingTemplate } from "./templates.js";
import { getOrCreateCustomer, logMessage, recentMessages } from "../services/customer.js";
import { getEnabledTools, runTool } from "./tools.js";
import { completeChat } from "./llm.js";
import { prisma } from "../db.js";
import { menuForCustomer } from "../services/menu.js";

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
  await logMessage(customer.id, restaurantId, "user", userText);

  // Load up to 20 recent messages for context (includes the message just logged)
  const history = await recentMessages(customer.id, 20);

  // First message = only the current user message exists in history
  const isFirstMessage = history.length === 1;

  // Returning customer sending a plain greeting — show menu again without going through LLM.
  // Prevents the scope-rejection firing on innocent "hi / hello / hey" messages.
  const isGreeting = /^(hi|hello|hey|helo|hai|hii|good\s*(morning|evening|afternoon|night)|namaste|vanakkam|start|menu)[\s!.,🙏]*$/i.test(userText.trim());

  // ── First message OR returning-customer greeting: skip LLM, reply with menu ──
  if (isFirstMessage || isGreeting) {
    const [cfg, menuText] = await Promise.all([
      prisma.botConfig.findUnique({ where: { id: restaurantId } }),
      menuForCustomer(restaurantId),
    ]);
    const reply = greetingTemplate(
      cfg?.restaurantName ?? "us",
      customer.name ?? undefined,
      menuText,
    );
    await logMessage(customer.id, restaurantId, "assistant", reply);
    return { reply };
  }

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

    // If a tool provided a fixed reply, use it and skip further LLM generation
    if (templateReply) break;
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
