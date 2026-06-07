import { config } from "../config.js";
import type { WhatsAppAdapter } from "./adapter.js";
import { BaileysAdapter } from "./baileys.js";
import { CloudAdapter } from "./cloud.js";
import { handleIncoming } from "../ai/agent.js";
import { getOrder } from "../services/order.js";

function makeAdapter(): WhatsAppAdapter {
  return config.whatsappProvider === "cloud"
    ? new CloudAdapter()
    : new BaileysAdapter();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Split a reply into separate WhatsApp bubbles on blank lines (human-like multi-message). */
function splitBubbles(text: string): string[] {
  const parts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts.slice(0, 4) : [text];
}

/** How long a human would take to "type" this message, in ms (reading + typing). */
function typingDelay(text: string): number {
  const ms = 700 + text.length * 45; // ~ a relaxed texting speed
  return Math.min(Math.max(ms, 900), 4500);
}

/** Send reply bubbles with realistic "typing…" pauses so it doesn't feel like a bot. */
async function sendHumanly(
  adapter: WhatsAppAdapter,
  phone: string,
  bubbles: string[],
) {
  // small initial pause as if reading the customer's message
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

async function notifyOwner(adapter: WhatsAppAdapter, orderId: number) {
  if (!config.ownerNumbers.length) return;
  const order = await getOrder(orderId);
  if (!order) return;
  const lines = order.items.map((i) => `  ${i.qty}x ${i.nameSnap} (₹${i.priceSnap})`).join("\n");
  const text =
    `🔔 New order #${order.id} (${order.type})\n` +
    `From: ${order.customer.name ?? order.customer.phone}\n` +
    `${lines}\n` +
    `Total: ₹${order.total}` +
    (order.note ? `\nNote: ${order.note}` : "");
  for (const num of config.ownerNumbers) {
    try {
      await adapter.sendText(num, text);
    } catch (e) {
      console.error("Owner notify failed:", e);
    }
  }
}

export async function runBot() {
  if (!config.aiApiKey) {
    console.warn(
      `⚠️  No AI key set for provider "${config.aiProvider}" — the bot can't generate replies.\n` +
        "   Groq: https://console.groq.com/keys  |  Cerebras (bigger free tier): https://cloud.cerebras.ai",
    );
  }
  const adapter = makeAdapter();

  adapter.onMessage(async (msg) => {
    console.log(`💬 ${msg.phone}: ${msg.text}`);
    try {
      const { reply, placedOrderId } = await handleIncoming(msg.phone, msg.text);
      console.log(`🤖 reply: ${reply.replace(/\n+/g, " / ")}`);
      await sendHumanly(adapter, msg.phone, splitBubbles(reply));
      if (placedOrderId) await notifyOwner(adapter, placedOrderId);
    } catch (e) {
      console.error("Handler error:", e);
      await adapter.sendText(
        msg.phone,
        "Sorry, Please try again in a moment.",
      );
    }
  });

  await adapter.start();
  console.log(`🤖 ${config.restaurantName} bot running (provider: ${config.whatsappProvider}).`);
}

// Allow running this file directly: `npm run bot`
runBot().catch((e) => {
  console.error(e);
  process.exit(1);
});
