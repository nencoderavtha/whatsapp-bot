import { prisma } from "../db.js";
import { notifyAdminOfEvent } from "./events.js";
import { getExactServiceDeliveryFee } from "./delivery-fee.js";
import { DeliveryManager } from "./delivery/delivery-manager.js";
import { refundPayment } from "./razorpay.js";
import { logger } from './logger.js';
import { DEFAULT_RESTAURANT_ID } from "../tenancy.js";
import { notify } from "./notification-center.js";

export interface OrderLineInput {
  menuItemId: number;
  variantId?: number;
  qty: number;
  note?: string;
}

/**
 * "YYYY-MM-DD" in Asia/Kolkata. This restaurant is India-only (Telugu, INR,
 * Razorpay, Shiprocket), so the business-day boundary is IST midnight, not
 * server-local or UTC midnight. `en-CA` is used purely because that locale's
 * formatting convention happens to be YYYY-MM-DD; there's no other tie to Canada.
 */
export function getBusinessDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}

/**
 * Atomically issue the next token for a restaurant's current business day.
 *
 * `businessDate` rolls over on its own at IST midnight (it's just today's date
 * computed fresh each call), so a new day's counter row simply doesn't exist
 * yet and starts at 1 — there is no cron job "resetting" anything.
 *
 * The INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING round-trip is the
 * same raw-SQL idiom used by the Postgres fallback lock in
 * conversation-lock.ts: Postgres serializes concurrent upserts on the same
 * primary key, so this is race-free without an explicit transaction or
 * advisory lock — two simultaneous callers for the same (restaurantId,
 * businessDate) can never receive the same token.
 */
export async function getNextToken(
  restaurantId: number,
): Promise<{ token: number; businessDate: string }> {
  const businessDate = getBusinessDate();
  const rows = await prisma.$queryRaw<Array<{ lastToken: number }>>`
    INSERT INTO "DailyTokenCounter" ("restaurantId", "businessDate", "lastToken", "updatedAt")
    VALUES (${restaurantId}, ${businessDate}, 1, NOW())
    ON CONFLICT ("restaurantId", "businessDate") DO UPDATE
      SET "lastToken" = "DailyTokenCounter"."lastToken" + 1, "updatedAt" = NOW()
    RETURNING "lastToken"
  `;
  return { token: rows[0].lastToken, businessDate };
}

export async function createOrder(params: {
  customerId: number;
  _restaurantId?: number;
  lines: OrderLineInput[];
  type?: string;
  deliveryFee?: number;
  deliveryAddress?: string;
  deliveryLat?: number;
  deliveryLng?: number;
  note?: string;
  payment?: { method: string; reference?: string; status?: string; paidAt?: Date };
}) {
  const ids = params.lines.map((l) => l.menuItemId);
  const items = await prisma.menuItem.findMany({
    where: { id: { in: ids } },
    include: { variants: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  let subtotal = 0;
  const orderItems = params.lines.map((l) => {
    const mi = byId.get(l.menuItemId);
    if (!mi) throw new Error(`Menu item ${l.menuItemId} not found`);
    const qty = Math.max(1, l.qty);

    let price = mi.price;
    let variantSnap: string | undefined;

    if (l.variantId) {
      const variant = mi.variants.find((v) => v.id === l.variantId);
      if (variant) {
        price = variant.price;
        variantSnap = variant.name;
      }
    }

    subtotal += price * qty;
    return {
      menuItemId: mi.id,
      variantId: l.variantId ?? null,
      variantSnap: variantSnap ?? null,
      nameSnap: mi.name,
      priceSnap: price,
      qty,
      note: l.note,
    };
  });

  const isDelivery = params.type === "delivery";
  let deliveryFee = 0;
  if (isDelivery) {
    if (params.deliveryFee !== undefined && params.deliveryFee !== null) {
      deliveryFee = params.deliveryFee;
    } else {
      try {
        const customer = await prisma.customer.findUnique({ where: { id: params.customerId } });
        deliveryFee = await getExactServiceDeliveryFee(params.deliveryAddress || customer?.address);
      } catch (e) {
        deliveryFee = 45;
      }
    }
  }
  const grandTotal = subtotal + deliveryFee;

  // Issue the daily display token before creating the order. If order.create
  // below fails for an unrelated reason (e.g. bad menu item id), this token is
  // simply never displayed on any order — a gap, not a duplicate. That's an
  // acceptable tradeoff: the spec requires uniqueness, not contiguity, and
  // trying to "return" an unused token on failure would reopen the same race
  // this is meant to close.
  const { token: tokenNumber, businessDate } = await getNextToken(
    params._restaurantId ?? DEFAULT_RESTAURANT_ID,
  );

  const order = await prisma.order.create({
    data: {
      customerId: params.customerId,
      type: params.type ?? "pickup",
      subtotal,
      deliveryFee,
      total: grandTotal,
      deliveryAddress: params.deliveryAddress ?? null,
      deliveryLat: params.deliveryLat ?? null,
      deliveryLng: params.deliveryLng ?? null,
      note: params.note,
      tokenNumber,
      businessDate,
      items: { create: orderItems },
      ...(params.payment
        ? {
            payment: {
              create: {
                status: params.payment.status ?? "pending",
                method: params.payment.method,
                reference: params.payment.reference ?? null,
                paidAt: params.payment.paidAt ?? null,
                amount: grandTotal,
              },
            },
          }
        : {}),
      ...(isDelivery
        ? {
            deliveryDispatch: {
              create: {
                providerCode: "shiprocket",
                deliveryFee: deliveryFee,
                status: "PENDING_KITCHEN",
                externalDeliveryId: "NOT_DISPATCHED_YET",
              },
            },
          }
        : {}),
    },
    include: {
      items: true,
      customer: true,
      payment: true,
      deliveryDispatch: true,
      deliveryQuotes: true,
    },
  });

  await notifyAdminOfEvent("order_created", order);
  void notify({
    type: "order_created",
    severity: "info",
    title: `New order ${order.tokenNumber != null ? `#${order.tokenNumber}` : `#${order.id}`}`,
    message: `${order.type === "delivery" ? "Delivery" : "Pickup"} order for ₹${order.total} placed.`,
    orderId: order.id,
    customerId: order.customerId,
  }).catch((e) => logger.error("[notify] order_created failed:", e));
  return order;
}

export async function findRecentDuplicate(
  customerId: number,
  lines: OrderLineInput[],
  withinMinutes = 15,
) {
  const since = new Date(Date.now() - withinMinutes * 60_000);
  const recent = await prisma.order.findMany({
    where: { customerId, createdAt: { gte: since }, status: { notIn: ["cancelled", "rejected"] } },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });

  const want = new Map<string, number>();
  for (const l of lines) {
    const key = `${l.menuItemId}:${l.variantId ?? 0}`;
    want.set(key, (want.get(key) ?? 0) + Math.max(1, l.qty));
  }

  for (const o of recent) {
    const have = new Map<string, number>();
    for (const it of o.items) {
      const key = `${it.menuItemId}:${it.variantId ?? 0}`;
      have.set(key, (have.get(key) ?? 0) + it.qty);
    }
    if (have.size !== want.size) continue;
    let same = true;
    for (const [key, qty] of want) if (have.get(key) !== qty) { same = false; break; }
    if (same) return o;
  }
  return null;
}

export async function listOrders(
  _restaurantId?: number,
  opts?: { status?: string; search?: string; dateFilter?: "today"; sort?: "newest" | "oldest" | "highest" | "lowest" },
) {
  const { status, search, dateFilter, sort } = opts ?? {};

  const where: Record<string, unknown> = {};
  if (status) where.status = status;

  if (search) {
    const asId = /^\d+$/.test(search) ? parseInt(search, 10) : null;
    where.OR = [
      { customer: { name: { contains: search, mode: "insensitive" } } },
      { type: { contains: search, mode: "insensitive" } },
      ...(asId !== null ? [{ id: asId }, { tokenNumber: asId }] : []),
    ];
  }

  if (dateFilter === "today") {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    where.createdAt = { gte: startOfToday };
  }

  const orderBy =
    sort === "oldest" ? { createdAt: "asc" as const } :
    sort === "highest" ? { total: "desc" as const } :
    sort === "lowest" ? { total: "asc" as const } :
    { createdAt: "desc" as const };

  return prisma.order.findMany({
    where,
    orderBy,
    include: {
      items: true,
      customer: true,
      payment: true,
      deliveryDispatch: true,
      deliveryQuotes: true,
    },
    take: 200,
  });
}

export async function setOrderStatus(id: number, status: string) {
  let updated = await prisma.order.update({
    where: { id },
    data: { status },
    include: {
      items: true,
      customer: true,
      payment: true,
      deliveryDispatch: true,
      deliveryQuotes: true,
    },
  });

  // When marked as ready for delivery orders -> auto-dispatch rider via algorithm!
  if (status === "ready" && updated.type === "delivery") {
    try {
      logger.info(`\n👩‍🍳 [Order Marked Ready] Auto-dispatching delivery rider for Order #${id}...`);
      await DeliveryManager.dispatchOrder(id);
      const refreshed = await prisma.order.findUnique({
        where: { id },
        include: {
          items: true,
          customer: true,
          payment: true,
          deliveryDispatch: true,
          deliveryQuotes: true,
        },
      });
      if (refreshed) updated = refreshed;
    } catch (err) {
      logger.error(`[Delivery Dispatch Error for Order #${id}]:`, err);
    }
  }

  await notifyAdminOfEvent("order_updated", updated);
  return updated;
}

export async function getOrder(id: number) {
  return prisma.order.findUnique({
    where: { id },
    include: {
      items: true,
      customer: true,
      payment: true,
      deliveryDispatch: true,
      deliveryQuotes: true,
    },
  });
}

export async function rejectOrder(id: number, reason: string) {
  const existing = await prisma.order.findUnique({
    where: { id },
    include: { payment: true },
  });
  if (!existing) throw new Error(`Order #${id} not found`);

  await prisma.order.update({
    where: { id },
    data: { status: "rejected", rejectionReason: reason },
  });

  if (existing.payment?.status === "paid") {
    const refund = await refundPayment(
      existing.payment.reference ?? "",
      existing.payment.amount,
    );
    if (refund.ok) {
      await prisma.order.update({
        where: { id },
        data: {
          refundStatus: "success",
          refundReference: refund.refundId,
          refundedAt: new Date(),
        },
      });
      await prisma.payment.update({
        where: { orderId: id },
        data: { status: "refunded" },
      });
    } else {
      logger.error(`[Reject Order #${id}] Refund failed:`, refund.error);
      await prisma.order.update({
        where: { id },
        data: { refundStatus: "failed" },
      });
      // Refund failures leave money stuck between the customer and the
      // restaurant — this must reach a human, not just sit in a log line.
      void notify({
        type: "refund_failed",
        severity: "critical",
        title: `Refund failed for order #${id}`,
        message: `Refund of ₹${existing.payment.amount} for order #${id} failed: ${refund.error ?? "unknown error"}. Please refund manually.`,
        orderId: id,
        customerId: existing.customerId,
      }).catch((e) => logger.error("[notify] refund_failed failed:", e));
    }
  }

  const updated = await prisma.order.findUnique({
    where: { id },
    include: {
      items: true,
      customer: true,
      payment: true,
      deliveryDispatch: true,
      deliveryQuotes: true,
    },
  });

  await notifyAdminOfEvent("order_updated", updated);
  return updated!;
}

export async function setPaymentStatus(
  orderId: number,
  status: string,
  paidAt?: Date,
) {
  const updated = await prisma.payment.update({
    where: { orderId },
    data: { status, paidAt: paidAt ?? (status === "paid" ? new Date() : undefined) },
  });
  await notifyAdminOfEvent("payment_updated", { orderId, status });
  return updated;
}
