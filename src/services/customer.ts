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

/**
 * A gap this long means the customer walked away and came back. What they say
 * next starts a new conversation, not a continuation of the old one.
 */
const IDLE_GAP_MS = 15 * 60 * 1000;

/**
 * Recent messages, cut at the last long silence.
 *
 * The model needs a conversation that starts somewhere sensible — feeding it
 * yesterday's order makes it answer about dishes nobody mentioned today. The old
 * way to get that was to `deleteMany` the customer's messages whenever the
 * conversation looked stale, which threw away the record permanently: the CRM,
 * the admin live-chat view and every future analysis lost the history, and a
 * misfire took the live cart with it.
 *
 * Trimming the window instead gives the model the same fresh context and keeps
 * the rows.
 */
export async function conversationWindow(customerId: number, limit = 20) {
  return sliceAtIdleGap(await recentMessages(customerId, limit));
}

/**
 * Drop everything before the most recent long silence.
 *
 * Split out from the query so the cut itself is testable without a database.
 * `rows` must be oldest-first, as `recentMessages` returns them.
 */
export function sliceAtIdleGap<T extends { createdAt: Date }>(
  rows: T[],
  idleGapMs: number = IDLE_GAP_MS,
): T[] {
  // Walk back from the newest message and stop at the first gap. Anything older
  // belongs to a previous visit.
  for (let i = rows.length - 1; i > 0; i--) {
    const gap = rows[i].createdAt.getTime() - rows[i - 1].createdAt.getTime();
    if (gap > idleGapMs) return rows.slice(i);
  }
  return rows;
}
