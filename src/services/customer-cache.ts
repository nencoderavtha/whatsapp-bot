import { redis } from "./redis.js";
import { logger } from "./logger.js";
import type { Customer } from "@prisma/client";

/**
 * Shared cache for the customer row, keyed by phone.
 *
 * Every inbound message resolves the sender before anything else can happen,
 * and with the database in Seoul and the service in Mumbai that is a round trip
 * on the critical path of every single turn.
 *
 * Redis only, deliberately — no in-memory layer. Cloud Run autoscales, so a
 * customer's next message frequently lands on a different container; a
 * per-instance copy would be invalidated on one instance and stale on the rest.
 *
 * The danger here is not a slow lookup, it is a stale address. A cached
 * customer whose address changed would be quoted for, and delivered to, the old
 * one. Invalidation therefore does not rely on call sites remembering: db.ts
 * intercepts every write to Customer through the Prisma client and drops the
 * entry, so a new write path added later cannot bypass it.
 */

const TTL_MS = 5 * 60_000;

function key(phone: string): string {
  return `cust:${phone}`;
}

export async function getCachedCustomer(phone: string): Promise<Customer | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(key(phone));
    if (!raw) return null;
    const c = JSON.parse(raw);
    // JSON has no Date type; the callers treat these as Dates.
    return {
      ...c,
      createdAt: new Date(c.createdAt),
      updatedAt: new Date(c.updatedAt),
      humanRequestedAt: c.humanRequestedAt ? new Date(c.humanRequestedAt) : null,
    } as Customer;
  } catch (e) {
    logger.warn("[customer-cache] read failed:", (e as Error)?.message ?? e);
    return null;
  }
}

export async function setCachedCustomer(customer: Customer): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key(customer.phone), JSON.stringify(customer), "PX", TTL_MS);
  } catch (e) {
    logger.warn("[customer-cache] write failed:", (e as Error)?.message ?? e);
  }
}

/**
 * Drop a customer from the cache.
 *
 * Called from the Prisma extension on every Customer write. The id-only case
 * exists because most writes identify the customer by id and never mention the
 * phone the cache is keyed on; rather than read the row back to learn it, the
 * phone is looked up from a small reverse index written alongside each entry.
 */
export async function invalidateCustomer(by: { phone?: string; id?: number }): Promise<void> {
  if (!redis) return;
  try {
    if (by.phone) {
      await redis.del(key(by.phone));
      return;
    }
    if (by.id !== undefined) {
      const phone = await redis.get(`cust-id:${by.id}`);
      if (phone) await redis.del(key(phone), `cust-id:${by.id}`);
    }
  } catch (e) {
    logger.warn("[customer-cache] invalidate failed:", (e as Error)?.message ?? e);
  }
}

/** Reverse index so an id-keyed write can find the phone-keyed entry. */
export async function indexCustomer(customer: Customer): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(`cust-id:${customer.id}`, customer.phone, "PX", TTL_MS);
  } catch (e) {
    logger.warn("[customer-cache] index failed:", (e as Error)?.message ?? e);
  }
}
