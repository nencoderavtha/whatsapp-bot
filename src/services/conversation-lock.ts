/**
 * Per-customer turn serialization that survives more than one instance.
 *
 * The bot answers one turn at a time per customer: a turn reads the cart, calls
 * the model, mutates the cart and sends a reply, and two of those interleaving
 * corrupts the order. That guarantee used to come from a `Map` in the agent
 * module, which is only a guarantee while exactly one process is running. Cloud
 * Run scales on request concurrency, so the second instance silently voided it.
 *
 * Postgres holds the lock instead. It is a *lease* — an instance that dies
 * mid-turn stops renewing, the lease expires, and the customer's next message
 * takes over rather than being locked out until someone notices.
 *
 * Redis would be the natural home for this and the eventual one; the point here
 * is that correctness must not wait for that migration.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";

/**
 * How long a lease is held before another instance may steal it.
 *
 * Long enough to cover a slow turn (the p99 is a few seconds, and a turn can hop
 * through six tool calls), short enough that a crashed instance doesn't strand
 * the customer. The holder renews while it works, so this is the *stall*
 * tolerance, not a turn budget.
 */
const LEASE_MS = 30_000;

/** Renewal cadence. Comfortably inside LEASE_MS so a slow tick doesn't drop it. */
const RENEW_MS = 10_000;

export interface ConversationLease {
  key: string;
  holder: string;
  /** Stop renewing and release. Safe to call twice. */
  release: () => Promise<void>;
}

/**
 * Take the lease for `key`, or return null if another instance holds a live one.
 *
 * The insert and the takeover are one statement so two instances racing for a
 * free lock cannot both win: the `WHERE` on the upsert only lets the write
 * through when the existing lease has already expired, and `RETURNING` tells us
 * whether the row we are looking at is ours.
 */
export async function acquire(key: string): Promise<ConversationLease | null> {
  const holder = randomUUID();
  const expiresAt = new Date(Date.now() + LEASE_MS);

  const rows = await prisma.$queryRaw<Array<{ holder: string }>>`
    INSERT INTO "ConversationLock" ("key", "holder", "expiresAt")
    VALUES (${key}, ${holder}, ${expiresAt})
    ON CONFLICT ("key") DO UPDATE
      SET "holder" = EXCLUDED."holder",
          "expiresAt" = EXCLUDED."expiresAt"
      WHERE "ConversationLock"."expiresAt" < NOW()
    RETURNING "holder"
  `;

  if (!rows.length || rows[0].holder !== holder) return null;

  const timer = setInterval(() => {
    void renew(key, holder);
  }, RENEW_MS);
  // A renewal timer must never be the reason the process stays alive.
  timer.unref?.();

  let released = false;
  return {
    key,
    holder,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        // Scoped to our holder id: if we stalled long enough to lose the lease,
        // the new holder's row is not ours to delete.
        await prisma.conversationLock.deleteMany({ where: { key, holder } });
      } catch (e) {
        // Leaving the row costs one lease expiry, not correctness.
        console.error(`[Lock] Could not release ${key}:`, e);
      }
    },
  };
}

async function renew(key: string, holder: string): Promise<void> {
  try {
    await prisma.conversationLock.updateMany({
      where: { key, holder },
      data: { expiresAt: new Date(Date.now() + LEASE_MS) },
    });
  } catch (e) {
    console.error(`[Lock] Renewal failed for ${key}:`, e);
  }
}

/**
 * Park a message for whichever instance is mid-turn for this customer.
 *
 * The caller answers nothing — the lock holder will fold this text into its next
 * turn, so the customer gets one reply covering everything they typed.
 */
export async function enqueue(key: string, text: string): Promise<void> {
  await prisma.queuedMessage.create({ data: { lockKey: key, text } });
}

/**
 * Take everything queued for `key`, oldest first, and remove it.
 *
 * `DELETE ... RETURNING` claims and reads in one statement, so two drains racing
 * each other cannot both come away with the same message — a read-then-delete
 * pair could, and the customer would get the item added to their cart twice.
 *
 * Ordering is applied here rather than in SQL because `RETURNING` makes no
 * promise about row order. `id` breaks ties between messages that landed in the
 * same millisecond.
 */
export async function drain(key: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: number; text: string; createdAt: Date }>>`
    DELETE FROM "QueuedMessage"
    WHERE "lockKey" = ${key}
    RETURNING "id", "text", "createdAt"
  `;

  return rows
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)
    .map((r) => r.text);
}
