/**
 * Notification center — the single place that turns an operational event
 * (new order, payment failure, refund failure, delivery failure, human
 * handoff, a stuck order) into:
 *
 *   1. A `Notification` row, so the dashboard has a durable, filterable feed.
 *   2. A real-time push over the existing SSE transport (`notifyAdminOfEvent`
 *      from ./events.js) — no new transport, this app already has one.
 *   3. For `critical` severity only, a best-effort WhatsApp alert to
 *      `RestaurantConfig.emergencyContacts` (never for `info`/`warning` —
 *      those are dashboard-only, since e.g. every new order already gets an
 *      owner WhatsApp message via `ownerNewOrderMsg` elsewhere, and duplicating
 *      that here would double-message the owner on every single order).
 *
 * Channel abstraction: `whatsapp` is the only channel that actually sends
 * anything today. `sms`/`email`/`push` are honest stubs — they log a warning
 * and report failure rather than pretending to deliver. This is a deliberate
 * scope decision, not an oversight: wiring a real SMS/email/push provider is
 * out of scope here, but the shape is in place so one can be dropped in later
 * without touching call sites.
 */
import { prisma } from "../db.js";
import { notifyAdminOfEvent } from "./events.js";
import { logger } from "./logger.js";
import { DEFAULT_RESTAURANT_ID } from "../tenancy.js";

export type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationType =
  | "order_created"
  | "payment_failed"
  | "refund_failed"
  | "delivery_failed"
  | "human_handoff"
  | "order_escalation";

export interface NotifyParams {
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  orderId?: number;
  customerId?: number;
  restaurantId?: number; // defaults to DEFAULT_RESTAURANT_ID
}

export interface ChannelResult {
  ok: boolean;
  error?: string;
}

export interface NotificationChannel {
  name: string;
  send(phone: string, message: string, restaurantId: number): Promise<ChannelResult>;
}

/**
 * The one real channel. Reuses the exact pattern `notifyOwner` /
 * `notifyOwnerOfHandoff` already use in session-manager.ts: fetch the live
 * adapter for the restaurant, send, and let one recipient's failure never
 * abort the others (that looping happens in `dispatchToContacts` below).
 *
 * Imported lazily (dynamic import) to avoid a load-time circular import —
 * session-manager.ts calls into this module from inside
 * `notifyOwnerOfHandoff`, and this module needs the bot session from
 * session-manager.ts. Deferring the import to call time (rather than a
 * top-level `import`) means neither module needs the other fully
 * initialized just to be loaded.
 */
export const whatsappChannel: NotificationChannel = {
  name: "whatsapp",
  async send(phone, message, restaurantId) {
    try {
      const { botSessionManager } = await import("../whatsapp/session-manager.js");
      const adapter = botSessionManager.getSession(restaurantId);
      if (!adapter) {
        return { ok: false, error: "No active WhatsApp session for this restaurant" };
      }
      await adapter.sendText(phone, message);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
};

function stubChannel(name: string): NotificationChannel {
  return {
    name,
    async send() {
      logger.warn(`[notification-center] ${name} channel not configured — no provider credentials`);
      return { ok: false, error: `${name} channel not configured — no provider credentials` };
    },
  };
}

/** Honest stubs — see file header. Never fabricate a delivery that didn't happen. */
export const smsChannel = stubChannel("sms");
export const emailChannel = stubChannel("email");
export const pushChannel = stubChannel("push");

const CHANNEL_REGISTRY: Record<string, NotificationChannel> = {
  whatsapp: whatsappChannel,
  sms: smsChannel,
  email: emailChannel,
  push: pushChannel,
};

/**
 * Parse `RestaurantConfig.notificationChannels` ("whatsapp,sms" etc.) into the
 * channel implementations to attempt, in the order configured. Falls back to
 * whatsapp-only if the config is empty/unrecognized, so a blank or corrupted
 * setting never means "silently deliver nothing".
 *
 * Pure and exported for unit testing.
 */
export function resolveChannels(channelsCsv: string | null | undefined): NotificationChannel[] {
  const names = (channelsCsv ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const resolved = names
    .map((n) => CHANNEL_REGISTRY[n])
    .filter((c): c is NotificationChannel => Boolean(c));
  return resolved.length ? resolved : [whatsappChannel];
}

/**
 * Whether delivery to emergency contacts should be skipped entirely (the row
 * is still written/emitted either way — this only governs the outbound alert
 * attempt). Pure and exported for unit testing.
 */
export function shouldSkipDelivery(
  cfg: { notificationsEnabled: boolean; criticalOnlyMode: boolean } | null | undefined,
  severity: NotificationSeverity,
): boolean {
  if (!cfg) return false;
  if (cfg.notificationsEnabled === false) return true;
  if (cfg.criticalOnlyMode && severity !== "critical") return true;
  return false;
}

/**
 * Send `message` to every contact over every configured channel, in order.
 * One recipient's/channel's failure never stops the rest — mirrors the
 * existing `notifyOwner` idiom in session-manager.ts. Reports success if at
 * least one send succeeded anywhere.
 *
 * Exported for unit testing with fake channels (no real network/DB calls).
 */
export async function dispatchToContacts(
  contacts: string[],
  channels: NotificationChannel[],
  message: string,
  restaurantId: number,
): Promise<{ ok: boolean; error?: string; channel?: string }> {
  let sentCount = 0;
  let lastError: string | undefined;
  let successChannel: string | undefined;

  for (const channel of channels) {
    for (const num of contacts) {
      try {
        const result = await channel.send(num, message, restaurantId);
        if (result.ok) {
          sentCount++;
          successChannel = channel.name;
        } else {
          lastError = result.error;
          logger.warn(`[notification-center] ${channel.name} send failed for ${num}: ${result.error}`);
        }
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        logger.error(`[notification-center] ${channel.name} send threw for ${num}:`, e);
      }
    }
  }

  return sentCount > 0 ? { ok: true, channel: successChannel } : { ok: false, error: lastError };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Write a Notification row, push it over SSE, and — for critical severity
 * only, when enabled — alert emergency contacts with one retry.
 */
export async function notify(params: NotifyParams): Promise<void> {
  const restaurantId = params.restaurantId ?? DEFAULT_RESTAURANT_ID;

  const row = await prisma.notification.create({
    data: {
      restaurantId,
      type: params.type,
      severity: params.severity,
      title: params.title,
      message: params.message,
      orderId: params.orderId ?? null,
      customerId: params.customerId ?? null,
      deliveryStatus: "pending",
    },
  });

  // Always emit — this is what makes the dashboard's toast/notification
  // center update instantly, regardless of whether emergency-contact
  // delivery below is attempted, skipped, or fails.
  await notifyAdminOfEvent("notification_created", row);

  const cfg = await prisma.restaurantConfig.findUnique({
    where: { id: restaurantId },
    select: {
      notificationsEnabled: true,
      criticalOnlyMode: true,
      notificationChannels: true,
      emergencyContacts: true,
    },
  });

  if (shouldSkipDelivery(cfg, params.severity)) {
    await prisma.notification.update({
      where: { id: row.id },
      data: { deliveryStatus: "skipped" },
    });
    return;
  }

  // Info/warning notifications are dashboard-only by design — see file header.
  if (params.severity !== "critical") {
    return;
  }

  const contacts = (cfg?.emergencyContacts ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (contacts.length === 0) {
    await prisma.notification.update({
      where: { id: row.id },
      data: { deliveryStatus: "skipped" },
    });
    return;
  }

  const channels = resolveChannels(cfg?.notificationChannels);
  const text = `${params.title}\n\n${params.message}`;

  let result = await dispatchToContacts(contacts, channels, text, restaurantId);
  if (!result.ok) {
    await delay(2000);
    result = await dispatchToContacts(contacts, channels, text, restaurantId);
  }

  if (result.ok) {
    await prisma.notification.update({
      where: { id: row.id },
      data: { deliveryStatus: "sent", channel: result.channel ?? null },
    });
  } else {
    logger.error(
      `[notification-center] failed to deliver notification #${row.id} to emergency contacts after retry:`,
      result.error,
    );
    await prisma.notification.update({
      where: { id: row.id },
      data: { deliveryStatus: "failed", retryCount: { increment: 1 } },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Order escalation checker — the first background job in this codebase.
// There is no cron/scheduler dependency here on purpose: a single
// `setInterval`, checked every few minutes, is all this needs.
// ─────────────────────────────────────────────────────────────────────────

const ESCALATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** An order left in "preparing" this long without moving on is worth a nudge. */
const STUCK_PREPARING_MINUTES = 30;
/** A delivery order still without a rider assigned this long is worth a nudge. */
const STUCK_RIDER_MINUTES = 30;

/**
 * Create an `order_escalation` notification for this order unless an
 * unacknowledged one already exists — the dedup guard that keeps a stuck
 * order from generating a fresh alert every single check interval.
 */
async function escalateOnce(
  orderId: number,
  customerId: number | null | undefined,
  title: string,
  message: string,
  severity: NotificationSeverity,
): Promise<void> {
  const existing = await prisma.notification.findFirst({
    where: { type: "order_escalation", orderId, acknowledgedAt: null },
  });
  if (existing) return;

  await notify({
    type: "order_escalation",
    severity,
    title,
    message,
    orderId,
    customerId: customerId ?? undefined,
  });
}

/**
 * One pass: find orders stuck in "preparing" too long, and delivery orders
 * whose dispatch is still searching for a rider too long, then escalate each
 * (deduped) exactly once per stuck condition.
 */
export async function checkOrderEscalations(): Promise<void> {
  const preparingThreshold = new Date(Date.now() - STUCK_PREPARING_MINUTES * 60_000);
  const riderThreshold = new Date(Date.now() - STUCK_RIDER_MINUTES * 60_000);

  try {
    const stuckPreparing = await prisma.order.findMany({
      where: { status: "preparing", updatedAt: { lte: preparingThreshold } },
      select: { id: true, customerId: true, tokenNumber: true, updatedAt: true },
    });

    for (const o of stuckPreparing) {
      const label = o.tokenNumber != null ? `#${o.tokenNumber}` : `#${o.id}`;
      await escalateOnce(
        o.id,
        o.customerId,
        `Order ${label} stuck in kitchen`,
        `Order ${label} has been in "preparing" for over ${STUCK_PREPARING_MINUTES} minutes without moving to ready. Please check on it.`,
        "warning",
      );
    }
  } catch (e) {
    logger.error("[notification-center] escalation check (preparing) failed:", e);
  }

  try {
    const stuckDispatches = await prisma.deliveryDispatch.findMany({
      where: {
        status: "SEARCHING_RIDER",
        dispatchedAt: { lte: riderThreshold },
        order: { status: { notIn: ["delivered", "cancelled", "rejected"] } },
      },
      select: {
        orderId: true,
        dispatchedAt: true,
        order: { select: { customerId: true, tokenNumber: true } },
      },
    });

    for (const d of stuckDispatches) {
      const label = d.order?.tokenNumber != null ? `#${d.order.tokenNumber}` : `#${d.orderId}`;
      await escalateOnce(
        d.orderId,
        d.order?.customerId,
        `Order ${label} has no rider assigned`,
        `Order ${label}'s delivery has been searching for a rider for over ${STUCK_RIDER_MINUTES} minutes. Please check with the delivery provider.`,
        "critical",
      );
    }
  } catch (e) {
    logger.error("[notification-center] escalation check (rider) failed:", e);
  }
}

let escalationTimer: NodeJS.Timeout | undefined;

/**
 * Start the background escalation checker. Call once from the process
 * entrypoint (src/whatsapp/run.ts). Safe to call more than once — later
 * calls are no-ops while a timer is already running.
 */
export function startEscalationChecker(intervalMs = ESCALATION_CHECK_INTERVAL_MS): NodeJS.Timeout {
  if (escalationTimer) return escalationTimer;
  escalationTimer = setInterval(() => {
    checkOrderEscalations().catch((e) =>
      logger.error("[notification-center] escalation check failed:", e),
    );
  }, intervalMs);
  // Don't hold the process open just for this timer (relevant for test runs).
  escalationTimer.unref?.();
  return escalationTimer;
}
