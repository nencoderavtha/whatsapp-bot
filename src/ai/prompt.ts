import { prisma } from "../db.js";
import { menuAsText, menuForCustomer } from "../services/menu.js";

export async function buildSystemPrompt(
  customerName: string | undefined,
  restaurantId: number,
  isFirstMessage: boolean,
  customerId?: number,
): Promise<string> {
  const [template, botConfig, menuText, greetMenu, pendingRow] = await Promise.all([
    prisma.promptTemplate.findFirst({ where: { restaurantId } }),
    prisma.botConfig.findFirst({ where: { id: restaurantId } }),
    menuAsText(restaurantId),
    isFirstMessage ? menuForCustomer(restaurantId) : Promise.resolve(""),
    customerId
      ? prisma.pendingOrder.findUnique({ where: { customerId } })
      : Promise.resolve(null),
  ]);

  if (!template) throw new Error(`No prompt template for restaurant ${restaurantId} — run: npm run db:seed`);
  if (!botConfig) throw new Error(`No bot config for restaurant ${restaurantId} — run: npm run db:seed`);

  let customerCtx: string;
  if (isFirstMessage && !customerName) {
    customerCtx = `FIRST MESSAGE — do ALL of these in your opening reply:
1. Greet the customer warmly in 1 sentence (introduce yourself as the ordering assistant for ${botConfig.restaurantName}).
2. Share the full menu below — use the exact WhatsApp formatting (bold category names, bullet items with prices).
3. End with "What would you like to order? 😊"

FULL MENU (copy this formatting exactly into your reply):
${greetMenu}`;
  } else if (isFirstMessage && customerName) {
    customerCtx = `FIRST MESSAGE: You know this customer as "${customerName}". Greet them by name, show the full menu, then ask what they'd like to order.

FULL MENU (show this in your reply):
${greetMenu}`;
  } else if (customerName) {
    customerCtx = `You know this customer as "${customerName}". No need to re-introduce yourself.`;
  } else {
    customerCtx = "";
  }

  // If there is a live staged order for this customer, prepend a critical context
  // block so the model never misclassifies "yes / ok / confirm" as out-of-scope.
  let stagedOrderBlock = "";
  if (pendingRow && !pendingRow.confirmedOrderId && pendingRow.expiresAt > new Date()) {
    const lines: Array<{ menuItemId: number; qty: number }> = JSON.parse(pendingRow.lines);
    stagedOrderBlock =
      `CURRENT ORDER STATE — HIGHEST PRIORITY\n` +
      `This customer has a STAGED ORDER waiting for action (${lines.length} line(s), type: ${pendingRow.type}).\n` +
      `Their next message IS part of the order flow — do NOT apply the scope rejection rule.\n` +
      `• If they confirm (yes / ok / sure / haan / ante / bilkul / ✅ etc.) → proceed to payment step.\n` +
      `• If they change their mind → call propose_order again with the updated items.\n` +
      `• If they cancel → acknowledge politely, clear the order in your reply.\n` +
      `DO NOT respond with "I can only help with orders" — the customer IS ordering.\n\n`;
  }

  // Injected rule to handle "yes" / short affirmatives after the bot showed specific items.
  // Without this, the AI asks "what would you like to order?" again instead of placing the item.
  const contextYesRule =
    `CONTEXT-AWARE SHORT REPLIES — MANDATORY\n` +
    `If your PREVIOUS message mentioned or listed specific item(s) and the customer replies with\n` +
    `"yes", "ok", "sure", "haan", "ante", "bilkul", "yeah", "yep", or any affirmative:\n` +
    `→ Treat it as "I want to order those items." Call propose_order immediately (qty 1 each, pickup default).\n` +
    `→ Do NOT ask "what would you like to order?" again — the customer already answered.\n` +
    `→ If multiple items were listed, ask "which one?" only when it is genuinely unclear.\n` +
    `→ If only ONE item was in context, never ask for clarification — just propose it.\n\n`;

  const basePrompt = template.content
    .replaceAll("{{restaurantName}}", botConfig.restaurantName)
    .replaceAll("{{restaurantCity}}", botConfig.restaurantCity)
    .replace("{{menu}}", menuText)
    .replace("{{customerGreeting}}", customerCtx);

  return stagedOrderBlock + contextYesRule + basePrompt;
}
