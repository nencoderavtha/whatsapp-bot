import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";

import { config } from "../config.js";

let openaiClient: OpenAI | undefined;
let gemini: GoogleGenerativeAI | undefined;

if (config.aiProvider !== "gemini") {
  openaiClient = new OpenAI({
    apiKey: config.aiApiKey,
    baseURL: config.aiBaseURL,
    maxRetries: 0,
  });
} else {
  if (config.geminiApiKey) {
    gemini = new GoogleGenerativeAI(config.geminiApiKey);
  }
}

async function completeOpenAICompatible(
  params: ChatCompletionCreateParamsNonStreaming,
  maxRetries = 3,
) {
  if (!openaiClient) throw new Error("OpenAI client not initialized");

  for (let attempt = 0; ; attempt++) {
    try {
      return await openaiClient.chat.completions.create(params);
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
        const waitS = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5 * (attempt + 1);
        if (!shouldRetry || waitS > 30) throw e;
        await new Promise((r) => setTimeout(r, waitS * 1000));
      }
      // Malformed tool call: immediate retry.
    }
  }
}

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type LlmResult = {
  content: string | undefined;
  toolCalls: ToolCall[];
};

const geminiToolInstruction =
  `\n\nIMPORTANT: If you need to call a tool, respond ONLY with this JSON (no markdown), ` +
  `using exactly these keys: {"tool_calls":[{"name":"propose_order|confirm_order|save_customer_info","arguments":{...}}],"final_text":"..."}. ` +
  `If no tool is needed, use {"tool_calls":[],"final_text":"..."}. ` +
  `final_text must be the message to customer.`;

export async function completeChat(params: {
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
  temperature: number;
  maxTokens: number;
}): Promise<LlmResult> {
  if (config.aiProvider === "gemini") {
    if (!gemini) throw new Error("Gemini not initialized (missing GEMINI_API_KEY)");

    const chat = gemini.getGenerativeModel({ model: config.aiModel });

    // Gemini expects plain text parts.
    const promptParts: any[] = [];
    for (const m of params.messages) {
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
      // If the provider didn't return JSON, treat everything as plain final text.
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

  const res = await completeOpenAICompatible({
    model: config.aiModel,
    messages: params.messages,
    tools: params.tools,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
  });

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
}

