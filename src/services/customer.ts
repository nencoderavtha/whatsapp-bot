import { prisma } from "../db.js";
import { notifyAdminOfEvent } from "./events.js";

export async function getOrCreateCustomer(
  phone: string,
  nameOrRestaurantId?: string | number,
  _restaurantId?: number,
) {
  const name = typeof nameOrRestaurantId === "string" ? nameOrRestaurantId : undefined;
  const validName = name && name.trim() && name.trim() !== "Unknown" ? name.trim() : undefined;

  return prisma.customer.upsert({
    where: { phone },
    update: {
      ...(validName ? { name: validName } : {}),
    },
    create: {
      phone,
      ...(validName ? { name: validName } : {}),
    },
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
  role: "user" | "assistant",
  content: string,
  mediaType: "text" | "audio" | "image" = "text",
  mediaUrl?: string,
) {
  const message = await prisma.message.create({
    data: { customerId, role, content, mediaType, mediaUrl },
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
