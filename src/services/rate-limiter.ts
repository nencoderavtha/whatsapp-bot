/**
 * Rate Limiting Service
 *
 * Provides per-user WhatsApp sliding-window rate limiting and Express API/Webhook
 * rate limiting. Uses Redis when available, with a clean in-memory fallback.
 */

import type { Request, Response, NextFunction } from "express";
import { redis } from "./redis.js";
import { logger } from "./logger.js";

// ── 1. Per-Customer WhatsApp Message Rate Limiter ─────────────────────────────
const USER_WINDOW_MS = 3 * 60 * 1000; // 3-minute sliding window
const MAX_MESSAGES_PER_WINDOW = 15;   // Max 15 messages per 3 mins per phone number

// In-memory fallback map if Redis is not configured
const memoryRateMap = new Map<string, { count: number; expiresAt: number }>();

/**
 * Check if a customer phone number has exceeded their message rate limit.
 * Returns { allowed: boolean, remaining: number }
 */
export async function checkUserRateLimit(phone: string): Promise<{ allowed: boolean; remaining: number }> {
  const cleanPhone = phone.replace(/\D/g, "");
  if (!cleanPhone) return { allowed: true, remaining: MAX_MESSAGES_PER_WINDOW };

  const rateKey = `ratelimit:user:${cleanPhone}`;

  // Redis Implementation
  if (redis) {
    try {
      const current = await redis.incr(rateKey);
      if (current === 1) {
        await redis.pexpire(rateKey, USER_WINDOW_MS);
      }

      if (current > MAX_MESSAGES_PER_WINDOW) {
        logger.warn(`⚠️ [Rate Limit Exceeded] Phone ${cleanPhone} sent ${current} msgs in 3m window.`);
        return { allowed: false, remaining: 0 };
      }

      return { allowed: true, remaining: Math.max(0, MAX_MESSAGES_PER_WINDOW - current) };
    } catch (e) {
      logger.error("[Redis Rate Limit Error, falling back to memory]:", e);
    }
  }

  // Memory Fallback Implementation
  const now = Date.now();
  const entry = memoryRateMap.get(cleanPhone);

  if (!entry || entry.expiresAt <= now) {
    memoryRateMap.set(cleanPhone, { count: 1, expiresAt: now + USER_WINDOW_MS });
    return { allowed: true, remaining: MAX_MESSAGES_PER_WINDOW - 1 };
  }

  entry.count += 1;
  if (entry.count > MAX_MESSAGES_PER_WINDOW) {
    logger.warn(`⚠️ [Rate Limit Exceeded (Memory)] Phone ${cleanPhone} sent ${entry.count} msgs.`);
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: Math.max(0, MAX_MESSAGES_PER_WINDOW - entry.count) };
}

// ── 2. Express API & Webhook Rate Limiting Middleware ───────────────────────
interface RateLimitOptions {
  windowMs: number;
  max: number;
  message: string;
}

const expressLimitMap = new Map<string, { count: number; resetAt: number }>();

export function createExpressRateLimiter(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.headers["x-forwarded-for"] as string || req.ip || "unknown").split(",")[0].trim();
    const key = `ratelimit:express:${req.baseUrl || req.path}:${ip}`;
    const now = Date.now();

    // Redis Implementation
    if (redis) {
      try {
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.pexpire(key, options.windowMs);
        }

        res.setHeader("X-RateLimit-Limit", options.max);
        res.setHeader("X-RateLimit-Remaining", Math.max(0, options.max - count));

        if (count > options.max) {
          logger.warn(`⚠️ [Express Rate Limit] Blocked IP ${ip} on ${req.method} ${req.path}`);
          res.status(429).json({ error: options.message });
          return;
        }

        next();
        return;
      } catch (e) {
        logger.error("[Express Redis Rate Limit Error, falling back to memory]:", e);
      }
    }

    // Memory Fallback
    let record = expressLimitMap.get(key);
    if (!record || record.resetAt <= now) {
      record = { count: 1, resetAt: now + options.windowMs };
      expressLimitMap.set(key, record);
    } else {
      record.count += 1;
    }

    res.setHeader("X-RateLimit-Limit", options.max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, options.max - record.count));

    if (record.count > options.max) {
      logger.warn(`⚠️ [Express Rate Limit (Memory)] Blocked IP ${ip} on ${req.method} ${req.path}`);
      res.status(429).json({ error: options.message });
      return;
    }

    next();
  };
}
