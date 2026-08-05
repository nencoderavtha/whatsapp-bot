import { Redis } from "ioredis";
import { logger } from "./logger.js";

// Global singleton so hot reloads in dev don't orphan connections
const globalForRedis = globalThis as unknown as {
  redisClient: Redis | undefined;
};

function getRedisUrl(): string | undefined {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const host = new URL(process.env.UPSTASH_REDIS_REST_URL).hostname;
      return `rediss://default:${process.env.UPSTASH_REDIS_REST_TOKEN}@${host}:6379`;
    } catch {}
  }
  return undefined;
}

const REDIS_URL = getRedisUrl();

let client: Redis | undefined;

if (REDIS_URL) {
  if (!globalForRedis.redisClient) {
    globalForRedis.redisClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) {
          logger.error("[Redis] Maximum retries reached. Failing over.");
          return null; // Stop retrying
        }
        return Math.min(times * 100, 3000);
      },
    });

    globalForRedis.redisClient.on("error", (err) => {
      logger.error("[Redis] Connection error:", err.message);
    });
    
    globalForRedis.redisClient.on("ready", () => {
      logger.info("[Redis] Connected successfully.");
    });
  }
  client = globalForRedis.redisClient;
}

/**
 * The configured Redis client instance, or undefined if Redis is not configured
 * or currently unavailable due to repeated connection failures.
 * Consumers MUST handle the undefined case to gracefully degrade to Postgres/Memory.
 */
export const redis = client;
