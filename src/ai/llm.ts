import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";

import { config, providerRegistry, providerKeys } from "../config.js";
import { logger } from "../services/logger.js";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type LlmResult = {
  content: string | undefined;
  toolCalls: ToolCall[];
};

type ProviderName = "openrouter" | "groq" | "cerebras" | "gemini";

// Active Provider Clients Map
const clients: Partial<Record<ProviderName, OpenAI | GoogleGenerativeAI>> = {};

function initClients() {
  const order: ProviderName[] = ["openrouter", "groq", "cerebras", "gemini"];
  for (const name of order) {
    const key = providerKeys[name];
    if (!key) continue;

    if (name === "gemini") {
      clients[name] = new GoogleGenerativeAI(key);
    } else {
      const reg = providerRegistry[name];
      clients[name] = new OpenAI({
        apiKey: key,
        baseURL: reg.baseURL,
        maxRetries: 0,
      });
    }
  }
}

initClients();

async function completeOpenAIProvider(
  client: OpenAI,
  modelName: string,
  params: Omit<ChatCompletionCreateParamsNonStreaming, "model">,
  maxRetries = 2,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.chat.completions.create({
        ...params,
        model: modelName,
      });
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      const msg = String(e?.message ?? e);
      const code = e?.error?.error?.code ?? e?.error?.code;

      const is429 = status === 429 || msg.includes("rate_limit") || msg.includes("429");
      const isBadToolCall = code === "tool_use_failed" || msg.includes("tool_use_failed");

      if ((!is429 && !isBadToolCall) || attempt >= maxRetries) throw e;

      if (is429) {
        const shouldRetry = (e?.headers?.get?.("x-should-retry") ?? "") !== "false";
        const retryAfter = Number(e?.headers?.get?.("retry-after"));
        const waitS = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 3 * (attempt + 1);
        if (!shouldRetry || waitS > 20) throw e;
        await new Promise((r) => setTimeout(r, waitS * 1000));
      }
    }
  }
}

const geminiToolInstruction =
  `\n\nIMPORTANT: If you need to call a tool, respond ONLY with this JSON (no markdown), ` +
  `using exactly these keys: {"tool_calls":[{"name":"propose_order|confirm_order|save_customer_info","arguments":{...}}],"final_text":"..."}. ` +
  `If no tool is needed, use {"tool_calls":[],"final_text":"..."}. ` +
  `final_text must be the message to customer.`;

async function completeGeminiProvider(
  sdk: GoogleGenerativeAI,
  modelName: string,
  messages: ChatCompletionMessageParam[],
): Promise<LlmResult> {
  const chat = sdk.getGenerativeModel({ model: modelName || "gemini-2.5-flash" });

  const promptParts: any[] = [];
  for (const m of messages) {
    if (m.role === "system") promptParts.push({ text: String(m.content ?? "") });
    else if (m.role === "user") promptParts.push({ text: String(m.content ?? "") });
    else if (m.role === "assistant") promptParts.push({ text: String(m.content ?? "") });
  }
  promptParts.push({ text: geminiToolInstruction });

  const result = await chat.generateContent(promptParts.map((p) => p.text).join("\n"));
  const raw = String(result.response.text() ?? "").trim();

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { content: raw, toolCalls: [] };
  }

  const finalText = String(parsed.final_text ?? "").trim();
  const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];

  return {
    content: finalText || undefined,
    toolCalls: toolCalls.map((tc: any, idx: number) => ({
      id: `gemini_tool_${idx}`,
      type: "function",
      function: {
        name: String(tc.name),
        arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
      },
    })),
  };
}

/**
 * Execute chat completion with automatic Multi-Provider Fallback Chain
 */
export async function completeChat(params: {
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
  temperature: number;
  maxTokens: number;
}): Promise<LlmResult> {
  const order: ProviderName[] = ["openrouter", "groq", "cerebras", "gemini"];
  const primary = (config.aiProvider as ProviderName) || "openrouter";

  // Order providers starting with the primary one
  const failoverChain: ProviderName[] = [
    primary,
    ...order.filter((p) => p !== primary && providerKeys[p]),
  ];

  let lastError: any = null;

  for (const provider of failoverChain) {
    const client = clients[provider];
    if (!client) continue;

    const reg = providerRegistry[provider];
    const modelName = config.aiModel || reg.defaultModel;

    try {
      if (provider === "gemini") {
        return await completeGeminiProvider(client as GoogleGenerativeAI, modelName, params.messages);
      }

      const res = await completeOpenAIProvider(
        client as OpenAI,
        modelName,
        {
          messages: params.messages,
          tools: params.tools,
          temperature: params.temperature,
          max_tokens: params.maxTokens,
        }
      );

      const msg = res.choices[0]?.message;
      return {
        content: msg?.content?.trim() || undefined,
        toolCalls: (msg?.tool_calls ?? []).map((tc: any) => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      };
    } catch (err: any) {
      lastError = err;
      logger.warn(
        `⚠️ [LLM Failover Chain] Provider "${provider}" failed (${err?.message ?? err}). Trying next fallback...`
      );
    }
  }

  throw lastError ?? new Error("All AI providers in the fallback chain failed.");
}
