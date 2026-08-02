import { z } from "zod";
import { completeChat } from "./llm.js";
import { logger } from "../services/logger.js";

export const INTENTS = [
  "ADD_ITEM", "REMOVE_ITEM", "UPDATE_QUANTITY", "CLEAR_CART",
  "CONFIRM_CART", "CHANGE_ADDRESS", "SELECT_ADDRESS",
  "CHECK_STATUS", "CANCEL_ORDER", "FAQ", "REQUEST_HUMAN",
  "GREETING", "OUT_OF_SCOPE", "UNKNOWN",
] as const;

export const IntentSchema = z.object({
  intent: z.enum(INTENTS),
  items: z.array(z.object({
    menuItemId: z.number(),
    qty: z.number().optional(),
    variantId: z.number().optional(),
    note: z.string().optional(),
  })).optional(),
  confidence: z.number(),
});

export type Intent = z.infer<typeof IntentSchema>;

/**
 * Resolve the unambiguous cases without calling the model.
 *
 * A button tap carries an id we chose ourselves — asking an LLM what
 * `confirm_order_btn` means is paying for a round trip to be told what we
 * already know. The same holds for a bare "hi" or "cancel".
 *
 * Deliberately conservative: only exact, normalised matches. Anything with
 * extra words ("cancel the biryani but keep the rice") falls through to the
 * model, because a wrong fast answer is far worse than a slow right one.
 * Cart edits always fall through — they need the menu to resolve item ids.
 *
 * Returns null when it isn't sure.
 */
export function fastClassifyIntent(latestMessage: string): Intent | null {
  const raw = latestMessage.trim();

  // Button ids we emit ourselves. Unambiguous by construction.
  if (/^menu_item_\d+(?:_v_\d+)?$/.test(raw)) return null; // needs item resolution
  const byButtonId: Record<string, Intent["intent"]> = {
    confirm_order_btn: "CONFIRM_CART",
    add_more_items_btn: "ADD_ITEM",
    view_menu: "FAQ",
    location_info: "FAQ",
    change_address: "CHANGE_ADDRESS",
    pin_new_location_btn: "CHANGE_ADDRESS",
    use_saved_address_btn: "SELECT_ADDRESS",
    use_saved_address: "SELECT_ADDRESS",
    confirm_delivery_addr_btn: "SELECT_ADDRESS",
  };
  if (byButtonId[raw]) return { intent: byButtonId[raw], confidence: 1 };
  if (/^(?:use_addr|saved_addr)_\d+$/.test(raw)) return { intent: "SELECT_ADDRESS", confidence: 1 };

  // Free text: strip punctuation and collapse whitespace, then match whole phrases.
  const t = raw.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
  if (!t) return null;

  const exact: Record<string, Intent["intent"]> = {};
  const put = (intent: Intent["intent"], phrases: string[]) =>
    phrases.forEach((p) => (exact[p] = intent));

  put("GREETING", ["hi", "hello", "hey", "namaste", "namaskar", "namaskaram", "start", "yo", "hola"]);
  put("CONFIRM_CART", ["confirm", "confirm order", "yes", "yes please", "ok", "okay", "haan", "ha", "sare", "avunu", "sure", "done", "proceed"]);
  put("CANCEL_ORDER", ["cancel", "cancel order", "cancel my order", "cancel cheyandi"]);
  put("CLEAR_CART", ["clear cart", "clear", "empty cart", "start over", "reset", "cart clear cheyandi"]);
  put("CHECK_STATUS", ["status", "order status", "wheres my order", "where is my order", "track", "track order", "na order ekkada"]);
  put("REQUEST_HUMAN", ["manager", "human", "staff", "agent", "talk to human", "speak to manager", "call me"]);
  put("CHANGE_ADDRESS", ["change address", "new address", "different address", "vere address", "address marchandi"]);

  const hit = exact[t];
  return hit ? { intent: hit, confidence: 1 } : null;
}

export async function classifyIntent(
  history: { role: "user" | "assistant"; content: string }[],
  latestMessage: string,
  menuText: string
): Promise<Intent> {
  // Skip the model entirely when the message is unambiguous.
  const fast = fastClassifyIntent(latestMessage);
  if (fast) return fast;

  const prompt = `
You are an intent classification engine for a restaurant ordering system. 
Your ONLY job is to analyze the user's latest message in the context of the conversation and output a structured JSON object representing their intent.

Do not generate conversational text. Only output JSON matching this structure:
{
  "intent": "ADD_ITEM",
  "items": [{ "menuItemId": 22, "qty": 2, "variantId": 4, "note": "less spicy" }],
  "confidence": 0.95
}

Use the numeric "menuItemId" and "variantId" fields exactly as shown. Do NOT
emit "name" or "variant" — output using those is rejected and the customer is
told the bot did not understand them.
Omit "items" entirely for intents that do not modify the cart.

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
Map the user's request to the actual item IDs from the provided menu.
For each item, provide:
- menuItemId: The exact numeric ID of the item from the menu (shown in brackets like [12]).
- qty: The quantity requested (default to 1 if unspecified).
- variantId: The specific numeric variant ID requested (shown as [v3]), if any.
- note: Any customization requested (e.g., "less spicy", "no onions").

### MENU
${menuText}
`;

  const messages: any[] = [
    { role: "system", content: prompt },
    ...history,
    { role: "user", content: latestMessage }
  ];

  // Kept outside the try so the failure log can show what the model actually
  // returned, rather than just that parsing failed.
  let rawContent: string | null | undefined;

  try {
    const res = await completeChat({
      messages,
      tools: [], // No tools
      temperature: 0, // Deterministic
      maxTokens: 500,
    });
    rawContent = res.content;

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

    logger.warn("[intent] Model returned no content — treating as UNKNOWN");
  } catch (e) {
    // This used to be swallowed with a comment claiming it was logged later; it
    // wasn't. A rejected-but-valid-looking response and a genuinely confused
    // customer both surfaced as "ardam kaledu", which made a fifth of all turns
    // impossible to explain. Log what we actually got.
    logger.warn("[intent] Could not parse classifier output — treating as UNKNOWN", {
      error: e instanceof Error ? e.message : String(e),
      raw: String(rawContent ?? "").slice(0, 400),
    });
  }

  return { intent: "UNKNOWN", confidence: 0 };
}
