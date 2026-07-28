/**
 * Per-customer turn serialization that survives more than one instance.
 *
 * Uses Redis for high-performance locking and queuing. If Redis is unavailable
 * (e.g., connection failure, or not configured), gracefully falls back to Postgres.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { logger } from './logger.js';
import { redis } from './redis.js';

const LEASE_MS = 30_000;
const RENEW_MS = 10_000;

export interface ConversationLease {
  key: string;
  holder: string;
  /** Stop renewing and release. Safe to call twice. */
  release: () => Promise<void>;
}

export async function acquire(key: string): Promise<ConversationLease | null> {
  const holder = randomUUID();

  // ----- REDIS IMPLEMENTATION -----
  // Bind to a local: the release callback below runs long after this function
  // returns, and the outer narrowing from `if (redis)` does not survive into it.
  const r = redis;
  if (r) {
    try {
      const lockKey = `lock:${key}`;
      const acquired = await r.set(lockKey, holder, "PX", LEASE_MS, "NX");
      
      if (!acquired) return null;

      const timer = setInterval(() => {
        void renewRedis(lockKey, holder);
      }, RENEW_MS);
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
            // Lua script to ensure we only delete the lock if we still hold it
            const script = `
              if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
              else
                return 0
              end
            `;
            await r.eval(script, 1, lockKey, holder);
          } catch (e) {
            logger.error(`[Redis Lock] Could not release ${key}:`, e);
          }
        },
      };
    } catch (e) {
      logger.error(`[Redis Lock] Acquire failed, falling back to Postgres:`, e);
      // Fall through to Postgres if Redis fails
    }
  }

  // ----- POSTGRES FALLBACK -----
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
    void renewPostgres(key, holder);
  }, RENEW_MS);
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
        await prisma.conversationLock.deleteMany({ where: { key, holder } });
      } catch (e) {
        logger.error(`[Postgres Lock] Could not release ${key}:`, e);
      }
    },
  };
}

async function renewRedis(lockKey: string, holder: string): Promise<void> {
  if (!redis) return;
  try {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    await redis.eval(script, 1, lockKey, holder, LEASE_MS);
  } catch (e) {
    logger.error(`[Redis Lock] Renewal failed for ${lockKey}:`, e);
  }
}

async function renewPostgres(key: string, holder: string): Promise<void> {
  try {
    await prisma.conversationLock.updateMany({
      where: { key, holder },
      data: { expiresAt: new Date(Date.now() + LEASE_MS) },
    });
  } catch (e) {
    logger.error(`[Postgres Lock] Renewal failed for ${key}:`, e);
  }
}

export async function enqueue(key: string, text: string): Promise<void> {
  if (redis) {
    try {
      await redis.rpush(`queue:${key}`, text);
      return;
    } catch (e) {
      logger.error(`[Redis Queue] Enqueue failed, falling back to Postgres:`, e);
    }
  }

  await prisma.queuedMessage.create({ data: { lockKey: key, text } });
}

export async function drain(key: string): Promise<string[]> {
  if (redis) {
    try {
      const qKey = `queue:${key}`;
      // MULTI block to read all and clear in one atomic operation
      const results = await redis.multi().lrange(qKey, 0, -1).del(qKey).exec();
      if (results && results[0] && !results[0][0]) { // first operation error check
        return (results[0][1] as string[]) || [];
      }
    } catch (e) {
      logger.error(`[Redis Queue] Drain failed, falling back to Postgres:`, e);
    }
  }

  const rows = await prisma.$queryRaw<Array<{ id: number; text: string; createdAt: Date }>>`
    DELETE FROM "QueuedMessage"
    WHERE "lockKey" = ${key}
    RETURNING "id", "text", "createdAt"
  `;

  return rows
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)
    .map((r) => r.text);
}
