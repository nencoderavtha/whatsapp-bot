import { prisma } from "../db.js";
import { menuAsText, menuForCustomer } from "../services/menu.js";

export async function buildSystemPrompt(
  customerName: string | undefined,
  restaurantId: number,
  isFirstMessage: boolean,
): Promise<string> {
  const [template, botConfig, menuText, greetMenu] = await Promise.all([
    prisma.promptTemplate.findFirst({ where: { restaurantId } }),
    prisma.botConfig.findFirst({ where: { id: restaurantId } }),
    menuAsText(restaurantId),
    isFirstMessage ? menuForCustomer(restaurantId) : Promise.resolve(""),
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

  return template.content
    .replaceAll("{{restaurantName}}", botConfig.restaurantName)
    .replaceAll("{{restaurantCity}}", botConfig.restaurantCity)
    .replace("{{menu}}", menuText)
    .replace("{{customerGreeting}}", customerCtx);
}
