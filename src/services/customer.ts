import { prisma } from "../db.js";
import { notifyAdminOfEvent } from "./events.js";

export async function getOrCreateCustomer(phone: string, restaurantId: number) {
  return prisma.customer.upsert({
    where: { phone_restaurantId: { phone, restaurantId } },
    update: {},
    create: { phone, restaurantId },
  });
}

export async function updateCustomer(
  customerId: number,
  data: { name?: string; address?: string; notes?: string },
) {
  const updated = await prisma.customer.update({ where: { id: customerId }, data });
  await notifyAdminOfEvent("customer_updated", updated);
  return updated;
}

export async function logMessage(
  customerId: number,
  restaurantId: number,
  role: "user" | "assistant",
  content: string,
) {
  const message = await prisma.message.create({
    data: { customerId, restaurantId, role, content },
    include: { customer: true },
  });
  await notifyAdminOfEvent("message_created", message);
  return message;
}

export async function recentMessages(customerId: number, limit = 20) {
  const rows = await prisma.message.findMany({
    where: { customerId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.reverse();
}
