import { z } from "zod";
import { completeChat } from "./llm.js";

export const INTENTS = [
  "ADD_ITEM", "REMOVE_ITEM", "UPDATE_QUANTITY", "CLEAR_CART",
  "CONFIRM_CART", "CHANGE_ADDRESS", "SELECT_ADDRESS",
  "CHECK_STATUS", "CANCEL_ORDER", "FAQ", "REQUEST_HUMAN",
  "GREETING", "OUT_OF_SCOPE", "UNKNOWN",
] as const;

export const IntentSchema = z.object({
  intent: z.enum(INTENTS),
  items: z.array(z.object({
    name: z.string(),
    qty: z.number().optional(),
    variant: z.string().optional(),
    note: z.string().optional(),
  })).optional(),
  confidence: z.number(),
});

export type Intent = z.infer<typeof IntentSchema>;

export async function classifyIntent(
  history: { role: "user" | "assistant"; content: string }[],
  latestMessage: string,
  menuText: string
): Promise<Intent> {
  const prompt = `
You are an intent classification engine for a restaurant ordering system. 
Your ONLY job is to analyze the user's latest message in the context of the conversation and output a structured JSON object representing their intent.

Do not generate conversational text. Only output JSON matching this structure:
{
  "intent": "...", 
  "items": [{ "name": "...", "qty": 1, "variant": "...", "note": "..." }],
  "confidence": 0.95
}

### CATEGORIES
Classify the intent into exactly ONE of the following categories:
- ADD_ITEM: The user wants to add food to their order.
- REMOVE_ITEM: The user wants to remove food from their order.
- UPDATE_QUANTITY: The user wants to change the amount of an item.
- CLEAR_CART: The user wants to empty their cart or start over.
- CONFIRM_CART: The user is confirming their order (e.g., "yes", "confirm", "proceed").
- CHANGE_ADDRESS: The user wants to change their delivery address.
- SELECT_ADDRESS: The user is providing or selecting an address.
- CHECK_STATUS: The user is asking about the status of their order or tracking.
- CANCEL_ORDER: The user wants to cancel their placed order.
- FAQ: The user is asking about menu availability, price, spice levels, location, hours, or general restaurant questions.
- REQUEST_HUMAN: The user wants to speak to staff, has a complaint, or needs a refund.
- GREETING: The user is saying hello (e.g., "hi", "namaste").
- OUT_OF_SCOPE: The user is talking about unrelated topics (e.g., coding, weather).
- UNKNOWN: The intent is completely unclear or ambiguous.

### ITEMS EXTRACTION
If the intent involves modifying the cart (ADD_ITEM, REMOVE_ITEM, UPDATE_QUANTITY), you must extract the items mentioned.
Map the user's request to the actual item names from the provided menu.
For each item, provide:
- name: The exact item name from the menu.
- qty: The quantity requested (default to 1 if unspecified).
- variant: The specific variant requested (e.g., "Bagara", "Annam"), if any.
- note: Any customization requested (e.g., "less spicy", "no onions").

### MENU
${menuText}
`;

  const messages: any[] = [
    { role: "system", content: prompt },
    ...history,
    { role: "user", content: latestMessage }
  ];

  try {
    const res = await completeChat({
      messages,
      tools: [], // No tools
      temperature: 0, // Deterministic
      maxTokens: 500,
    });
    
    if (res.content) {
      // Find JSON block if wrapped in markdown
      let jsonStr = res.content.trim();
      if (jsonStr.startsWith("\`\`\`json")) {
        jsonStr = jsonStr.replace(/^\`\`\`json\n?/, "").replace(/\n?\`\`\`$/, "");
      } else if (jsonStr.startsWith("\`\`\`")) {
        jsonStr = jsonStr.replace(/^\`\`\`\n?/, "").replace(/\n?\`\`\`$/, "");
      }
      const parsed = JSON.parse(jsonStr);
      const validated = IntentSchema.parse(parsed);
      return validated;
    }
  } catch (e) {
    // Return unknown on any parsing or validation failure
    // We log it later in the shadow log
  }

  return { intent: "UNKNOWN", confidence: 0 };
}
