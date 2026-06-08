import { prisma } from "../db.js";
import { menuAsText } from "../services/menu.js";

export async function buildSystemPrompt(
  customerName: string | undefined,
  restaurantId: number,
  isFirstMessage: boolean,
): Promise<string> {
  const [template, botConfig, menuText] = await Promise.all([
    prisma.promptTemplate.findFirst({ where: { restaurantId } }),
    prisma.botConfig.findFirst({ where: { id: restaurantId } }),
    menuAsText(restaurantId),
  ]);

  if (!template) throw new Error(`No prompt template for restaurant ${restaurantId} — run: npm run db:seed`);
  if (!botConfig) throw new Error(`No bot config for restaurant ${restaurantId} — run: npm run db:seed`);

  let customerCtx: string;
  if (isFirstMessage && !customerName) {
    customerCtx = `FIRST MESSAGE: This is the customer's very first message. Open with a warm, brief greeting that identifies you as the ordering assistant for ${botConfig.restaurantName}. Example: "Hi! I'm Rajamma, your ordering assistant for ${botConfig.restaurantName} 😊 What would you like to order today?" — keep it natural, one or two sentences max.`;
  } else if (isFirstMessage && customerName) {
    customerCtx = `FIRST MESSAGE: You know this customer as "${customerName}". Greet them by name briefly, then get right to taking their order.`;
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
