import { prisma } from "../db.js";
import { notifyAdminOfEvent } from "./events.js";

export type ActivityType =
  | "response_time"
  | "tool_error"
  | "fallback"
  | "human_handoff"
  | "handoff_resolved";

/**
 * Record a bot-health event for the dashboard Activity tab.
 * Writes an ActivityLog row AND broadcasts it over SSE (activity_logged) so the
 * dashboard updates live. Always fire-and-forget from callers (`void logActivity`)
 * so it never blocks a customer reply — internal errors are swallowed.
 */
export async function logActivity(
  restaurantId: number,
  type: ActivityType,
  message: string,
  meta?: Record<string, unknown>,
  customerId?: number,
): Promise<void> {
  try {
    const row = await prisma.activityLog.create({
      data: {
        restaurantId,
        type,
        message,
        meta: meta ? JSON.stringify(meta) : null,
        customerId: customerId ?? null,
      },
    });
    await notifyAdminOfEvent("activity_logged", row);
  } catch (e) {
    console.error("[activity] logActivity failed:", e);
  }
}
