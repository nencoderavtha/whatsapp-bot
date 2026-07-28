import { prisma } from "../db.js";
import { notifyAdminOfEvent } from "./events.js";
import { getExactServiceDeliveryFee } from "./delivery-fee.js";
import { DeliveryManager } from "./delivery/delivery-manager.js";
import { logger } from './logger.js';

export interface OrderLineInput {
  menuItemId: number;
  variantId?: number;
  qty: number;
  note?: string;
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
  return order;
}

export async function findRecentDuplicate(
  customerId: number,
  lines: OrderLineInput[],
  withinMinutes = 15,
) {
  const since = new Date(Date.now() - withinMinutes * 60_000);
  const recent = await prisma.order.findMany({
    where: { customerId, createdAt: { gte: since }, status: { not: "cancelled" } },
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

export async function listOrders(_restaurantId?: number, status?: string) {
  return prisma.order.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
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
