import { prisma } from "../db.js";
import { notifyAdminOfEvent } from "./events.js";
import { logger } from "./logger.js";

export type ActivityType =
  | "response_time"
  | "tool_error"
  | "fallback"
  | "human_handoff"
  | "handoff_resolved"
  | "intent_shadow";

export async function logActivity(
  _restaurantId: number,
  type: ActivityType,
  message: string,
  meta?: Record<string, unknown>,
  customerId?: number,
): Promise<void> {
  try {
    const row = await prisma.activityLog.create({
      data: {
        type,
        message,
        meta: meta ? JSON.stringify(meta) : null,
        customerId: customerId ?? null,
      },
    });
    await notifyAdminOfEvent("activity_logged", row);
  } catch (e) {
    logger.error("[activity] logActivity failed:", e);
  }
}
