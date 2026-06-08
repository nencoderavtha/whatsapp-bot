import { prisma } from "../db.js";
import { BaileysAdapter } from "./baileys.js";
import { CloudAdapter } from "./cloud.js";
import type { WhatsAppAdapter, InboundMessage } from "./adapter.js";
import { handleIncoming } from "../ai/agent.js";
import { getOrder } from "../services/order.js";
import { config } from "../config.js";
import { notifyAdminOfEvent } from "../services/events.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function splitBubbles(text: string): string[] {
  const parts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts.slice(0, 4) : [text];
}

function typingDelay(text: string): number {
  return Math.min(Math.max(700 + text.length * 45, 900), 4500);
}

async function sendHumanly(adapter: WhatsAppAdapter, phone: string, bubbles: string[]) {
  await sleep(600 + Math.random() * 700);
  for (let i = 0; i < bubbles.length; i++) {
    const bubble = bubbles[i];
    await adapter.setTyping?.(phone, true);
    await sleep(typingDelay(bubble));
    await adapter.setTyping?.(phone, false);
    await adapter.sendText(phone, bubble);
    if (i < bubbles.length - 1) await sleep(500 + Math.random() * 600);
  }
}

async function notifyOwner(adapter: WhatsAppAdapter, restaurantId: number, orderId: number) {
  const cfg = await prisma.botConfig.findUnique({ where: { id: restaurantId } });
  const stored = cfg?.ownerNumbers ?? "";
  const ownerNumbers = stored.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ownerNumbers.length) return;

  const order = await getOrder(orderId);
  if (!order) return;

  const lines = order.items.map((i) => `  ${i.qty}x ${i.nameSnap} (₹${i.priceSnap})`).join("\n");
  const text =
    `🔔 New order #${order.id} (${order.type})\n` +
    `From: ${order.customer.name ?? order.customer.phone}\n` +
    `${lines}\n` +
    `Total: ₹${order.total}` +
    (order.note ? `\nNote: ${order.note}` : "");

  for (const num of ownerNumbers) {
    try {
      await adapter.sendText(num, text);
    } catch (e) {
      console.error(`[r${restaurantId}] Owner notify failed:`, e);
    }
  }
}

export class BotSessionManager {
  private sessions = new Map<number, WhatsAppAdapter>();
  // Cloud API only: phoneNumberId → restaurantId for fast webhook routing
  private phoneIdMap = new Map<string, number>();

  /** Start sessions for all active restaurants. */
  async startAll() {
    const restaurants = await prisma.botConfig.findMany({ where: { isActive: true } });
    console.log(`🚀 Starting ${restaurants.length} bot session(s) [provider: ${config.whatsappProvider}]...`);
    for (const r of restaurants) {
      await this.startSession(r.id, r.restaurantName).catch((e) =>
        console.error(`Failed to start session for restaurant ${r.id}:`, e),
      );
    }
  }

  /** Start (or restart) a single restaurant's WhatsApp session. */
  async startSession(restaurantId: number, restaurantName: string) {
    if (this.sessions.has(restaurantId)) {
      console.log(`[r${restaurantId}] Session already running — skipping.`);
      return;
    }

    const botCfg = await prisma.botConfig.findUnique({
      where: { id: restaurantId },
      select: { whatsappPhone: true, cloudPhoneNumberId: true, cloudToken: true },
    });

    let adapter: WhatsAppAdapter;

    if (config.whatsappProvider === "cloud") {
      const phoneNumberId = botCfg?.cloudPhoneNumberId ?? config.cloud.phoneNumberId;
      const token = botCfg?.cloudToken ?? config.cloud.token;
      if (!phoneNumberId || !token) {
        console.warn(`[r${restaurantId}] Cloud API not configured (missing phoneNumberId or token) — skipping.`);
        return;
      }
      adapter = new CloudAdapter(phoneNumberId, token);
      this.phoneIdMap.set(phoneNumberId, restaurantId);
    } else {
      const authDir = `sessions/restaurant-${restaurantId}`;
      adapter = new BaileysAdapter(authDir, restaurantId, botCfg?.whatsappPhone ?? undefined);
    }

    adapter.onMessage(async (msg) => {
      console.log(`[${restaurantName}] 💬 ${msg.phone}: ${msg.text}`);
      try {
        const cfg = await prisma.botConfig.findUnique({
          where: { id: restaurantId },
          select: { botPaused: true, pauseMessage: true },
        });
        if (cfg?.botPaused) {
          const pauseMsg = cfg.pauseMessage ?? "Sorry, we're temporarily unavailable. We'll be back shortly! 🙏";
          await sendHumanly(adapter, msg.phone, [pauseMsg]);
          return;
        }

        const { reply, placedOrderId } = await handleIncoming(msg.phone, msg.text, restaurantId);
        console.log(`[${restaurantName}] 🤖 ${reply.replace(/\n+/g, " / ")}`);
        await sendHumanly(adapter, msg.phone, splitBubbles(reply));
        if (placedOrderId) await notifyOwner(adapter, restaurantId, placedOrderId);
      } catch (e) {
        console.error(`[${restaurantName}] Handler error:`, e);
        await adapter.sendText(msg.phone, "Sorry, please try again in a moment.");
      }
    });

    await adapter.start();
    this.sessions.set(restaurantId, adapter);
    console.log(`✅ Bot session started: ${restaurantName} (restaurant ${restaurantId})`);

    // Cloud API is always connected — signal the dashboard immediately.
    if (config.whatsappProvider === "cloud") {
      await notifyAdminOfEvent("whatsapp_connected", {});
    }
  }

  /** Stop a session (e.g. when a restaurant is deactivated). */
  stopSession(restaurantId: number) {
    // Clean up Cloud phone ID mapping
    for (const [phoneId, rId] of this.phoneIdMap.entries()) {
      if (rId === restaurantId) this.phoneIdMap.delete(phoneId);
    }
    this.sessions.delete(restaurantId);
    console.log(`🛑 Session removed for restaurant ${restaurantId}`);
  }

  /**
   * Route an inbound Cloud webhook message to the correct restaurant's handler.
   * Called by the admin server's POST /webhook route.
   */
  async routeCloudMessage(phoneNumberId: string, msg: InboundMessage): Promise<void> {
    const restaurantId = this.phoneIdMap.get(phoneNumberId);
    if (restaurantId === undefined) {
      console.warn(`[Cloud] No session found for phoneNumberId=${phoneNumberId}`);
      return;
    }
    const adapter = this.sessions.get(restaurantId) as CloudAdapter;
    await adapter?.ingest(msg);
  }

  getSession(restaurantId: number): WhatsAppAdapter | undefined {
    return this.sessions.get(restaurantId);
  }

  isRunning(restaurantId: number) {
    return this.sessions.has(restaurantId);
  }

  get count() {
    return this.sessions.size;
  }
}

// Singleton shared between bot and admin webhook handler (same process via index.ts).
export const botSessionManager = new BotSessionManager();
