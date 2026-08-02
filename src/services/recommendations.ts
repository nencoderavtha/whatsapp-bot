import { prisma } from "../db.js";
import { redis } from "./redis.js";
import { logger } from "./logger.js";

export interface Pairing {
  itemId: number;
  name: string;
  priceLabel: string;
  pitch: string;
  source: "owner" | "orders";
}

/**
 * How many separate orders must contain a pair before it is suggested.
 *
 * One order containing two dishes says nothing — a single customer ordering
 * biryani and a soft drink once is not evidence that they go together. Below
 * this the learned source stays silent rather than recommending from noise,
 * which means it produces nothing at all until real order volume exists.
 */
const MIN_CO_OCCURRENCE = 2;

/** Suggestions are remembered for the life of a cart, so the same one is not pushed twice. */
const SUGGESTED_TTL_MS = 2 * 60 * 60 * 1000;

function suggestedKey(customerId: number): string {
  return `suggested:${customerId}`;
}

async function alreadySuggested(customerId: number): Promise<Set<number>> {
  if (!redis) return new Set();
  try {
    const raw = await redis.get(suggestedKey(customerId));
    return new Set(raw ? (JSON.parse(raw) as number[]) : []);
  } catch (e) {
    logger.warn("[recommendations] could not read suggestion history:", (e as Error)?.message ?? e);
    return new Set();
  }
}

async function rememberSuggested(customerId: number, itemId: number): Promise<void> {
  if (!redis) return;
  try {
    const seen = await alreadySuggested(customerId);
    seen.add(itemId);
    await redis.set(suggestedKey(customerId), JSON.stringify([...seen]), "PX", SUGGESTED_TTL_MS);
  } catch (e) {
    logger.warn("[recommendations] could not record suggestion:", (e as Error)?.message ?? e);
  }
}

/** Forget what has been suggested — called when a cart is cleared or an order is placed. */
export async function resetSuggestions(customerId: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(suggestedKey(customerId));
  } catch {
    // A stale suggestion history is not worth failing an order over.
  }
}

function priceLabelFor(item: { price: number; variants: { price: number }[] }): string {
  if (item.variants.length === 0) return `₹${item.price}`;
  const prices = item.variants.map((v) => v.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? `₹${min}` : `₹${min}–₹${max}`;
}

/**
 * What to offer alongside what is already in the cart.
 *
 * Two sources, in order of authority:
 *
 *   1. Pairings the restaurant configured. The owner knows that their biryani
 *      goes with mirchi ka salan; nothing here should second-guess that.
 *   2. What customers actually ordered together, learned from OrderItem.
 *
 * The learned source only fills the gap where the owner has said nothing, and
 * needs several orders to agree before it speaks. Anything already in the cart,
 * sold out, unavailable, or suggested earlier in this cart is excluded — being
 * offered a dish you just added reads as the bot not following the conversation.
 *
 * Returns null freely. No suggestion is always better than a bad one.
 */
export async function suggestPairing(
  customerId: number,
  cartItemIds: number[],
  _restaurantId?: number,
): Promise<Pairing | null> {
  if (cartItemIds.length === 0) return null;

  const skip = await alreadySuggested(customerId);
  const exclude = new Set([...cartItemIds, ...skip]);

  const usable = (item: { available: boolean; stockCount: number | null }) =>
    item.available && (item.stockCount === null || item.stockCount > 0);

  // ── 1. What the restaurant said ──────────────────────────────────────────
  const owner = await prisma.itemRecommendation.findMany({
    where: { menuItemId: { in: cartItemIds }, recommendedItemId: { notIn: [...exclude] } },
    include: { recommendedItem: { include: { variants: { where: { available: true } } } } },
  });

  for (const rec of owner) {
    const item = rec.recommendedItem;
    if (!usable(item)) continue;
    await rememberSuggested(customerId, item.id);
    return {
      itemId: item.id,
      name: item.name,
      priceLabel: priceLabelFor(item),
      pitch: rec.pitchMessage?.trim() || `Deenitho paatu *${item.name}* baguntundi andi 👌`,
      source: "owner",
    };
  }

  // ── 2. What customers ordered together ───────────────────────────────────
  // Counts distinct orders, not line items, so one customer ordering the same
  // pair repeatedly does not manufacture a trend on its own.
  let coOccurring: Array<{ menuItemId: number; orders: number }> = [];
  try {
    coOccurring = await prisma.$queryRawUnsafe(
      `SELECT other."menuItemId" AS "menuItemId", COUNT(DISTINCT other."orderId")::int AS orders
         FROM "OrderItem" mine
         JOIN "OrderItem" other
           ON other."orderId" = mine."orderId"
          AND other."menuItemId" <> mine."menuItemId"
        WHERE mine."menuItemId" = ANY($1::int[])
          AND other."menuItemId" <> ALL($2::int[])
        GROUP BY other."menuItemId"
       HAVING COUNT(DISTINCT other."orderId") >= $3
        ORDER BY orders DESC
        LIMIT 5`,
      cartItemIds,
      [...exclude],
      MIN_CO_OCCURRENCE,
    );
  } catch (e) {
    logger.warn("[recommendations] co-occurrence query failed:", (e as Error)?.message ?? e);
    return null;
  }

  for (const row of coOccurring) {
    const item = await prisma.menuItem.findUnique({
      where: { id: row.menuItemId },
      include: { variants: { where: { available: true } } },
    });
    if (!item || !usable(item)) continue;
    await rememberSuggested(customerId, item.id);
    return {
      itemId: item.id,
      name: item.name,
      priceLabel: priceLabelFor(item),
      pitch: `Chaala mandi deenitho paatu *${item.name}* teesukuntaru andi 👌`,
      source: "orders",
    };
  }

  return null;
}
