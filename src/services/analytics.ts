/**
 * Owner-only analytics aggregation for the admin dashboard.
 *
 * Single-restaurant schema (see prisma/schema.prisma header) — `Order` and
 * friends carry no `restaurantId` column, so unlike some other services here
 * there is no tenant scoping to apply; every query below is already scoped
 * correctly by just filtering on `createdAt`/status/etc.
 *
 * All date-range math is done in Asia/Kolkata calendar days, reusing the
 * exact IST-boundary convention `getBusinessDate()` already established in
 * ./order.ts (see that file's comment for why `en-CA` is used). Every Prisma
 * query filters `Order.createdAt` (UTC-stored) against the real UTC instant
 * that corresponds to an IST midnight — never a string compare.
 */
import { prisma } from "../db.js";
import { getBusinessDate } from "./order.js";

export class InvalidRangeError extends Error {}

export type AnalyticsRangeKey = "today" | "yesterday" | "last7" | "month" | "custom";

const RANGE_LABELS: Record<AnalyticsRangeKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 Days",
  month: "This Month",
  custom: "Custom Range",
};

// Orders in these statuses are excluded from every revenue/"valid order" style
// metric — they never resulted in food actually going out.
const EXCLUDED_FROM_REVENUE = ["cancelled", "rejected"];
const ACTIVE_STATUSES = ["pending", "confirmed", "preparing", "ready"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** "YYYY-MM-DD" (IST calendar date) -> the UTC instant of that date's IST midnight. */
function istMidnight(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+05:30`);
}

/** Pure calendar arithmetic on a "YYYY-MM-DD" string — no timezone involved. */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function enumerateDates(fromStr: string, toStrInclusive: string): string[] {
  const dates: string[] = [];
  let cur = fromStr;
  while (cur <= toStrInclusive) {
    dates.push(cur);
    cur = addDays(cur, 1);
  }
  return dates;
}

/** "Aug 5" — short month + day, no year. `dateStr` is an IST calendar date. */
function dayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}

/** IST hour-of-day (0-23) for a UTC instant. */
function istHour(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const raw = parts.find((p) => p.type === "hour")?.value ?? "0";
  const h = parseInt(raw, 10);
  return h === 24 ? 0 : h;
}

function hourLabel24(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

/** "19:00" -> "07:00 PM" */
function to12hLabel(label24: string): string {
  const h = parseInt(label24.slice(0, 2), 10);
  const period = h < 12 ? "AM" : "PM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${String(h12).padStart(2, "0")}:00 ${period}`;
}

interface ResolvedRange {
  key: AnalyticsRangeKey;
  label: string;
  from: Date;
  to: Date;
  granularity: "hour" | "day";
  fromDateStr: string; // IST calendar date the range starts on — used to build day buckets
  toDateStr: string; // IST calendar date the range's last (possibly partial) day falls on
}

function resolveRange(
  rangeParam: string | undefined,
  fromParam: string | undefined,
  toParam: string | undefined,
  now: Date,
): ResolvedRange {
  const key = (rangeParam || "today") as AnalyticsRangeKey;
  const todayStr = getBusinessDate(now);

  if (key === "today") {
    return { key, label: RANGE_LABELS.today, from: istMidnight(todayStr), to: now, granularity: "hour", fromDateStr: todayStr, toDateStr: todayStr };
  }
  if (key === "yesterday") {
    const yStr = addDays(todayStr, -1);
    return { key, label: RANGE_LABELS.yesterday, from: istMidnight(yStr), to: istMidnight(todayStr), granularity: "hour", fromDateStr: yStr, toDateStr: yStr };
  }
  if (key === "last7") {
    const startStr = addDays(todayStr, -6);
    return { key, label: RANGE_LABELS.last7, from: istMidnight(startStr), to: now, granularity: "day", fromDateStr: startStr, toDateStr: todayStr };
  }
  if (key === "month") {
    const startStr = `${todayStr.slice(0, 7)}-01`;
    return { key, label: RANGE_LABELS.month, from: istMidnight(startStr), to: now, granularity: "day", fromDateStr: startStr, toDateStr: todayStr };
  }
  if (key === "custom") {
    if (!fromParam || !toParam || !isValidDateStr(fromParam) || !isValidDateStr(toParam)) {
      throw new InvalidRangeError("range=custom requires valid from and to dates (YYYY-MM-DD)");
    }
    const singleDay = fromParam === toParam;
    return {
      key,
      label: RANGE_LABELS.custom,
      from: istMidnight(fromParam),
      to: istMidnight(addDays(toParam, 1)),
      granularity: singleDay ? "hour" : "day",
      fromDateStr: fromParam,
      toDateStr: toParam,
    };
  }
  throw new InvalidRangeError(`invalid range: "${rangeParam}"`);
}

export interface AnalyticsQuery {
  range?: string;
  from?: string;
  to?: string;
}

export async function getOrdersAnalytics(query: AnalyticsQuery, now: Date = new Date()) {
  const range = resolveRange(query.range, query.from, query.to, now);
  const { from, to } = range;
  const inRange = { gte: from, lt: to };
  const validOrderWhere = { createdAt: inRange, status: { notIn: EXCLUDED_FROM_REVENUE } };

  const [
    statusGroups,
    refundedCount,
    validAgg,
    refundOutflowAgg,
    inflowGroups,
    servedRows,
    waitingForAcceptance,
    waitingForRider,
    deliveryDurations,
    delayedOrders,
    humanHandoffRequests,
    itemsSoldAgg,
    bestItemGroups,
    categoryRows,
    bucketRows,
  ] = await Promise.all([
    prisma.order.groupBy({ by: ["status"], where: { createdAt: inRange }, _count: { _all: true } }),
    prisma.order.count({ where: { createdAt: inRange, refundStatus: "success" } }),
    prisma.order.aggregate({
      where: validOrderWhere,
      _sum: { total: true, subtotal: true, deliveryFee: true },
      _max: { total: true },
      _min: { total: true },
      _count: { _all: true },
    }),
    prisma.payment.aggregate({
      where: { order: { createdAt: inRange, refundStatus: "success" } },
      _sum: { amount: true },
    }),
    prisma.payment.groupBy({
      by: ["method"],
      where: { status: "paid", order: { createdAt: inRange } },
      _sum: { amount: true },
    }),
    prisma.order.findMany({ where: { createdAt: inRange }, select: { customerId: true }, distinct: ["customerId"] }),
    prisma.order.count({ where: { status: "pending", createdAt: inRange } }),
    prisma.order.count({
      where: {
        type: "delivery",
        status: "ready",
        createdAt: inRange,
        OR: [{ deliveryDispatch: null }, { deliveryDispatch: { status: "SEARCHING_RIDER" } }],
      },
    }),
    prisma.deliveryDispatch.findMany({
      where: { order: { createdAt: inRange }, deliveredAt: { not: null } },
      select: { dispatchedAt: true, deliveredAt: true },
    }),
    // Intentionally NOT scoped to `range` — this is a "right now" queue-health
    // metric (matches the >30min urgency styling already used in orders.js),
    // not a historical count for the selected date range.
    prisma.order.count({
      where: { status: { in: ACTIVE_STATUSES }, createdAt: { lt: new Date(now.getTime() - 30 * 60 * 1000) } },
    }),
    prisma.activityLog.count({ where: { type: "human_handoff", createdAt: inRange } }),
    prisma.orderItem.aggregate({ where: { order: validOrderWhere }, _sum: { qty: true } }),
    prisma.orderItem.groupBy({
      by: ["nameSnap"],
      where: { order: validOrderWhere },
      _sum: { qty: true },
      orderBy: { _sum: { qty: "desc" } },
      take: 1,
    }),
    // Category attribution needs the OrderItem -> MenuItem -> Category join,
    // which groupBy can't express — a narrow findMany + in-memory reduce is
    // the documented exception. Rows whose menuItemId went null (the menu
    // item was later deleted) are excluded rather than fabricating a category.
    prisma.orderItem.findMany({
      where: { menuItemId: { not: null }, order: validOrderWhere },
      select: { qty: true, menuItem: { select: { category: { select: { name: true } } } } },
    }),
    // Per-bucket (hour/day) time-window aggregation needs row-level createdAt,
    // which is likewise unavailable to groupBy — narrow select, single query.
    prisma.order.findMany({ where: { createdAt: inRange }, select: { status: true, total: true, createdAt: true } }),
  ]);

  // ---- orders.* ------------------------------------------------------
  const countByStatus: Record<string, number> = {};
  for (const g of statusGroups) countByStatus[g.status] = g._count._all;
  const pending = countByStatus["pending"] ?? 0;
  const preparing = (countByStatus["confirmed"] ?? 0) + (countByStatus["preparing"] ?? 0);
  const dispatched = countByStatus["ready"] ?? 0;
  const delivered = countByStatus["delivered"] ?? 0;
  const cancelled = countByStatus["cancelled"] ?? 0;
  const rejected = countByStatus["rejected"] ?? 0;
  const total = pending + preparing + dispatched + delivered + cancelled + rejected;
  const active = pending + preparing + dispatched;
  const completed = delivered;
  const refunded = refundedCount;

  const orders = { total, completed, active, pending, preparing, dispatched, delivered, cancelled, rejected, refunded };

  // ---- revenue.* -------------------------------------------------------
  const validCount = validAgg._count._all;
  const totalSales = validAgg._sum.total ?? 0;
  const totalOrderValue = validAgg._sum.subtotal ?? 0;
  const totalDeliveryFees = validAgg._sum.deliveryFee ?? 0;
  const highestOrderValue = validAgg._max.total ?? 0;
  const lowestOrderValue = validCount > 0 ? validAgg._min.total ?? 0 : 0;
  const avgOrderValue = validCount > 0 ? totalSales / validCount : 0;

  // ---- cashflow.* --------------------------------------------------
  let inflowTotal = 0;
  let inflowOnline = 0;
  let inflowCash = 0;
  for (const g of inflowGroups) {
    const amt = g._sum.amount ?? 0;
    inflowTotal += amt;
    if (g.method === "upi" || g.method === "razorpay") inflowOnline += amt;
    else if (g.method === "cash") inflowCash += amt;
  }
  const refundsOutflow = refundOutflowAgg._sum.amount ?? 0;
  const outflowTotal = refundsOutflow;
  const netEarnings = inflowTotal - outflowTotal;
  const totalRevenue = totalSales - outflowTotal;

  const revenue = {
    totalSales,
    totalRevenue,
    totalOrderValue,
    totalDeliveryFees,
    avgOrderValue,
    highestOrderValue,
    lowestOrderValue,
  };

  const cashflow = {
    inflow: { total: inflowTotal, online: inflowOnline, cash: inflowCash },
    outflow: { total: outflowTotal, refunds: refundsOutflow },
    netEarnings,
  };

  // ---- customers.* -----------------------------------------------------
  const servedIds = servedRows.map((r) => r.customerId);
  const totalServed = servedIds.length;
  const newCount =
    servedIds.length > 0
      ? await prisma.customer.count({ where: { id: { in: servedIds }, createdAt: inRange } })
      : 0;
  const customers = {
    totalServed,
    new: newCount,
    returning: totalServed - newCount,
    // NOTE for the frontend: this schema has no separate "complaint" concept —
    // complaints route through the same request_human_handoff path as any
    // other human-handoff request (see src/ai/prompt.ts), so this one number
    // is what the UI should label for both "Human Handoff Requests" and
    // "Customer Complaints" rather than a fabricated second count.
    humanHandoffRequests,
  };

  // ---- operational.* -----------------------------------------------
  let avgDeliveryMinutes: number | null = null;
  if (deliveryDurations.length > 0) {
    const totalMinutes = deliveryDurations.reduce(
      (sum, d) => sum + (d.deliveredAt!.getTime() - d.dispatchedAt.getTime()) / 60000,
      0,
    );
    avgDeliveryMinutes = totalMinutes / deliveryDurations.length;
  }

  const operational = {
    waitingForAcceptance,
    waitingForRider,
    avgDeliveryMinutes,
    // ALWAYS null — Order has no per-status-transition timestamp (only
    // createdAt/updatedAt, and updatedAt is touched by unrelated writes too:
    // payment status, delivery status, etc.) so prep time can't be computed
    // honestly. Left present (not omitted) so the frontend can render "Not
    // tracked yet" instead of hiding the tile.
    avgPrepMinutes: null as number | null,
    delayedOrders,
  };

  // ---- products.* --------------------------------------------------
  const totalItemsSold = itemsSoldAgg._sum.qty ?? 0;
  const avgItemsPerOrder = validCount > 0 ? totalItemsSold / validCount : 0;
  const bestItemGroup = bestItemGroups[0];
  const bestSellingItem =
    bestItemGroup && (bestItemGroup._sum.qty ?? 0) > 0
      ? { name: bestItemGroup.nameSnap, qty: bestItemGroup._sum.qty ?? 0 }
      : null;

  const categoryTotals = new Map<string, number>();
  for (const row of categoryRows) {
    const name = row.menuItem?.category?.name;
    if (!name) continue;
    categoryTotals.set(name, (categoryTotals.get(name) ?? 0) + row.qty);
  }
  let bestSellingCategory: { name: string; qty: number } | null = null;
  for (const [name, qty] of categoryTotals) {
    if (!bestSellingCategory || qty > bestSellingCategory.qty) bestSellingCategory = { name, qty };
  }

  const products = {
    totalItemsSold,
    totalOrdersSold: total,
    avgItemsPerOrder,
    bestSellingItem,
    bestSellingCategory,
  };

  // ---- charts.* ----------------------------------------------------
  const isValidStatus = (status: string) => !EXCLUDED_FROM_REVENUE.includes(status);

  let revenueTrendBuckets: Array<{ label: string; revenue: number }>;
  let ordersByHourBuckets: Array<{ label: string; orders: number; revenue: number }>;

  if (range.granularity === "hour") {
    revenueTrendBuckets = Array.from({ length: 24 }, (_, h) => ({ label: hourLabel24(h), revenue: 0 }));
    ordersByHourBuckets = Array.from({ length: 24 }, (_, h) => ({ label: hourLabel24(h), orders: 0, revenue: 0 }));
    for (const o of bucketRows) {
      const h = istHour(o.createdAt);
      ordersByHourBuckets[h].orders += 1;
      const validRevenue = isValidStatus(o.status) ? o.total : 0;
      ordersByHourBuckets[h].revenue += validRevenue;
      revenueTrendBuckets[h].revenue += validRevenue;
    }
  } else {
    const dateList = enumerateDates(range.fromDateStr, range.toDateStr);
    const indexOf = new Map(dateList.map((ds, i) => [ds, i]));
    revenueTrendBuckets = dateList.map((ds) => ({ label: dayLabel(ds), revenue: 0 }));
    ordersByHourBuckets = dateList.map((ds) => ({ label: dayLabel(ds), orders: 0, revenue: 0 }));
    for (const o of bucketRows) {
      const ds = getBusinessDate(o.createdAt);
      const idx = indexOf.get(ds);
      if (idx === undefined) continue; // outside the enumerated span; shouldn't happen given the query bounds
      ordersByHourBuckets[idx].orders += 1;
      const validRevenue = isValidStatus(o.status) ? o.total : 0;
      ordersByHourBuckets[idx].revenue += validRevenue;
      revenueTrendBuckets[idx].revenue += validRevenue;
    }
  }

  const orderStatusRows = [
    { status: "pending", count: pending },
    { status: "preparing", count: preparing },
    { status: "dispatched", count: dispatched },
    { status: "delivered", count: delivered },
    { status: "cancelled", count: cancelled },
    { status: "rejected", count: rejected },
    { status: "refunded", count: refunded },
  ].map((r) => ({ ...r, pct: total > 0 ? Math.round((r.count / total) * 100) : 0 }));

  const charts = {
    revenueTrend: { granularity: range.granularity, buckets: revenueTrendBuckets },
    ordersByHour: { granularity: range.granularity, buckets: ordersByHourBuckets },
    orderStatus: orderStatusRows,
    revenueSplit: { total: totalSales, food: totalOrderValue, delivery: totalDeliveryFees, refund: outflowTotal },
    cashflowBars: { inflow: inflowTotal, outflow: outflowTotal },
  };

  // ---- insights.* -----------------------------------------------------
  let peakHour: string | null = null;
  if (range.granularity === "hour" && total > 0) {
    let maxIdx = 0;
    for (let i = 1; i < ordersByHourBuckets.length; i++) {
      if (ordersByHourBuckets[i].orders > ordersByHourBuckets[maxIdx].orders) maxIdx = i;
    }
    if (ordersByHourBuckets[maxIdx].orders > 0) peakHour = to12hLabel(ordersByHourBuckets[maxIdx].label);
  }

  const insights = {
    peakHour,
    bestSellingItem: bestSellingItem?.name ?? null,
    bestSellingCategory: bestSellingCategory?.name ?? null,
    avgOrderValue,
    avgDeliveryMinutes,
    avgPrepMinutes: null as number | null,
    newCustomersToday: newCount,
    humanHandoffRequests,
    netEarnings,
    totalOrdersCompleted: completed,
  };

  return {
    range: {
      key: range.key,
      label: range.label,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      granularity: range.granularity,
    },
    orders,
    revenue,
    cashflow,
    customers,
    operational,
    products,
    charts,
    insights,
  };
}
