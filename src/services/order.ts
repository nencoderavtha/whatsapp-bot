import { prisma } from "../db.js";
import { notifyAdminOfEvent } from "./events.js";

export interface OrderLineInput {
  menuItemId: number;
  qty: number;
  note?: string;
}

/** Create an order, snapshotting names/prices so later menu edits don't change history. */
export async function createOrder(params: {
  customerId: number;
  lines: OrderLineInput[];
  type?: string;
  note?: string;
}) {
  const ids = params.lines.map((l) => l.menuItemId);
  const items = await prisma.menuItem.findMany({ where: { id: { in: ids } } });
  const byId = new Map(items.map((i) => [i.id, i]));

  let total = 0;
  const orderItems = params.lines.map((l) => {
    const mi = byId.get(l.menuItemId);
    if (!mi) throw new Error(`Menu item ${l.menuItemId} not found`);
    const qty = Math.max(1, l.qty);
    total += mi.price * qty;
    return {
      menuItemId: mi.id,
      nameSnap: mi.name,
      priceSnap: mi.price,
      qty,
      note: l.note,
    };
  });

  const order = await prisma.order.create({
    data: {
      customerId: params.customerId,
      type: params.type ?? "pickup",
      note: params.note,
      total,
      items: { create: orderItems },
    },
    include: { items: true, customer: true },
  });

  await notifyAdminOfEvent("order_created", order);
  return order;
}

/**
 * Find a non-cancelled order from this customer with the SAME cart placed in the
 * last `withinMinutes`. Used to make order placement idempotent so the AI can't
 * create duplicate orders if it calls place_order more than once.
 */
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

  const want = new Map<number, number>();
  for (const l of lines) want.set(l.menuItemId, (want.get(l.menuItemId) ?? 0) + Math.max(1, l.qty));

  for (const o of recent) {
    const have = new Map<number, number>();
    for (const it of o.items) have.set(it.menuItemId, (have.get(it.menuItemId) ?? 0) + it.qty);
    if (have.size !== want.size) continue;
    let same = true;
    for (const [id, qty] of want) if (have.get(id) !== qty) { same = false; break; }
    if (same) return o;
  }
  return null;
}

export async function listOrders(status?: string) {
  return prisma.order.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    include: { items: true, customer: true },
    take: 200,
  });
}

export async function setOrderStatus(id: number, status: string) {
  const updated = await prisma.order.update({
    where: { id },
    data: { status },
    include: { items: true, customer: true }
  });
  await notifyAdminOfEvent("order_updated", updated);
  return updated;
}

export async function getOrder(id: number) {
  return prisma.order.findUnique({
    where: { id },
    include: { items: true, customer: true },
  });
}
