import { prisma } from "../db.js";
import { notifyAdminOfEvent } from "./events.js";

/** Get or create the customer record for a WhatsApp phone number. */
export async function getOrCreateCustomer(phone: string) {
  return prisma.customer.upsert({
    where: { phone },
    update: {},
    create: { phone },
  });
}

export async function updateCustomer(
  phone: string,
  data: { name?: string; address?: string; notes?: string },
) {
  const updated = await prisma.customer.update({ where: { phone }, data });
  await notifyAdminOfEvent("customer_updated", updated);
  return updated;
}

/** Append a message to the conversation log (the bot's memory). */
export async function logMessage(
  customerId: number,
  role: "user" | "assistant",
  content: string,
) {
  const message = await prisma.message.create({
    data: { customerId, role, content },
    include: { customer: true },
  });
  await notifyAdminOfEvent("message_created", message);
  return message;
}

/** Recent conversation turns, oldest first, for AI context. */
export async function recentMessages(customerId: number, limit = 20) {
  const rows = await prisma.message.findMany({
    where: { customerId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.reverse();
}

