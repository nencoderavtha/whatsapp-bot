import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { systemPrompt } from "./prompt.js";
import { menuAsText } from "../services/menu.js";
import {
  getOrCreateCustomer,
  logMessage,
  recentMessages,
} from "../services/customer.js";

import { tools, runTool } from "./tools.js";
import { completeChat } from "./llm.js";

export interface AgentResult {
  reply: string;
  placedOrderId?: number;
}

function looksLikeToolGarbage(s: string): boolean {
  const c = s.trim();
  return (
    c.startsWith("{") ||
    c.startsWith("[") ||
    c.includes('"name"') ||
    c.includes("propose_order") ||
    c.includes("confirm_order") ||
    c.includes("tool_calls") ||
    c.includes("tool_call") ||
    c.includes("function")
  );
}

/**
 * Run one turn of the conversation for a given WhatsApp phone number.
 * Loads memory, calls the configured LLM with tools, executes tools, persists everything.
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

  // Tool loop: keep going until the model produces natural language.
  for (let hop = 0; hop < 6; hop++) {
    const { content, toolCalls } = await completeChat({
      messages,
      tools,
      temperature: 0.8,
      maxTokens: 700,
    });

    // If model did not request tools, use content.
    if (!toolCalls.length) {
      if (content && !looksLikeToolGarbage(content)) finalText = content;
      break;
    }

    // Give tool results to the model in the next hop.
    // Push a lightweight assistant turn so the model sees it requested tools.
    messages.push({ role: "assistant", content: undefined } as any);

    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }

      const { output, orderId } = await runTool(
        customer.id,
        tc.function.name,
        args,
      );
      if (orderId) placedOrderId = orderId;

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(output),
      } as any);
    }
  }

  if (!finalText) finalText = "Sorry, please retry again after sometime?";
  await logMessage(customer.id, "assistant", finalText);
  return { reply: finalText, placedOrderId };
}

