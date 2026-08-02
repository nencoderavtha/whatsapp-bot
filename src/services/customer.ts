import { prisma } from "../db.js";
import { notifyAdminOfEvent } from "./events.js";
import { logger } from "./logger.js";
import { getCachedCustomer, setCachedCustomer, indexCustomer } from "./customer-cache.js";

export async function getOrCreateCustomer(
  phone: string,
  nameOrRestaurantId?: string | number,
  _restaurantId?: number,
) {
  const name = typeof nameOrRestaurantId === "string" ? nameOrRestaurantId : undefined;
  const validName = name && name.trim() && name.trim() !== "Unknown" ? name.trim() : undefined;

  // This runs before anything else on every inbound message. For a returning
  // customer whose name hasn't changed the upsert wrote a row identical to the
  // one already there, paying a cross-region round trip on the critical path of
  // every turn to do it.
  const cached = await getCachedCustomer(phone);
  if (cached && (!validName || cached.name === validName)) return cached;

  const customer = await prisma.customer.upsert({
    where: { phone },
    update: {
      ...(validName ? { name: validName } : {}),
    },
    create: {
      phone,
      ...(validName ? { name: validName } : {}),
    },
  });

  // The upsert above invalidates through the Prisma extension in db.ts, so
  // populate the cache afterwards rather than racing it.
  void setCachedCustomer(customer).then(() => indexCustomer(customer));
  return customer;
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

/**
 * Record an outbound message when only the phone number is known.
 *
 * The adapter sends to a phone; logMessage needs a customer id. Everything the
 * bot says used to be logged by its caller, which meant every renderer-driven
 * message — cart summary, address picker, quote, payment link — went out
 * unrecorded, so the dashboard showed the customer's half of a conversation
 * with the replies missing.
 *
 * Never throws: failing to write a transcript row must not stop a customer
 * receiving their payment link.
 */
export async function logOutboundMessage(phone: string, content: string) {
  try {
    if (!content.trim()) return;
    const customer = await prisma.customer.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (!customer) return;
    await logMessage(customer.id, "assistant", content);
  } catch (e) {
    logger.warn(
      `[logOutboundMessage] Could not record an outbound message to ${phone}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
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
