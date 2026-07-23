/**
 * Fixed WhatsApp message templates for predictable bot responses.
 * WhatsApp formatting: *bold*, _italic_, ~strikethrough~, ```mono```
 * No markdown headers (#). Voice: plain, brief, max ONE emoji per message
 * (usually 🙏 on handoff/thanks, ✅ on a confirmed order) — no upsell language.
 *
 * Each template uses pick() to rotate phrasing slightly so customers don't
 * feel like they're reading from a fixed script, without adding any energy
 * or emoji beyond what the brand voice allows.
 */

/** Pick a random element from an array — for natural message variation. */
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const TYPE_LABEL: Record<string, string> = {
  pickup: "Pickup",
  delivery: "Delivery",
  "dine-in": "Dine-in",
};

// ── Sent after propose_order stages the cart ────────────────────────────────

export function orderStagedTemplate(
  items: string[],
  total: number,
  type: string,
  note?: string,
): string {
  const typeLabel = TYPE_LABEL[type] ?? "Pickup";
  const noteLine = note ? `\nNote: ${note}` : "";
  const itemList = items.map((i) => `• ${i}`).join("\n");

  return [
    `Order idi andi —`,
    itemList,
    `Total: ₹${total} · ${typeLabel}${noteLine}`,
    `Confirm cheyyocha?`,
  ].join("\n");
}

// ── Sent after generate_payment_link creates a Razorpay link ────────────────

export function paymentLinkTemplate(url: string, total: number): string {
  return [
    `₹${total} pay cheyyandi andi:`,
    url,
    `Pay ayyaka order confirm avutundi.`,
  ].join("\n\n");
}

// ── Sent after confirm_order places the order ────────────────────────────
// Note: a full itemized receipt is also sent automatically by session-manager.

export function orderConfirmedTemplate(): string {
  return pick([
    `Confirm chesam ✅ Receipt ippude pampistham.`,
    `Order confirm ayyindi ✅ Receipt vastundi konchem sepatlo.`,
  ]);
}

// ── Sent when a customer (or the bot) requests a human staff member ──────────

export function humanHandoffTemplate(): string {
  return pick([
    `Sorry andi 🙏 Manager ki cheppanu — working hours lo ikkade reply istharu.`,
    `Ok andi 🙏 Team ki pass chesanu, working hours lo direct ga message chestaru.`,
  ]);
}

// ── Fallback when the bot couldn't produce a proper reply ────────────────────

export function fallbackTemplate(): string {
  return pick([
    `Ardam kaledu andi, malli oka sari cheppagalara?`,
    `Sorry andi, clear ga randledu — malli pampandi.`,
  ]);
}

// ── Shown when a voice note is received (no speech-to-text yet) ─────────────

export function voiceNoteFallbackTemplate(): string {
  return `Voice message vachindi andi. Text lo pampandi, leda call chestham.`;
}

// ── Shown when something breaks on our side (caught exception) ────────────────

export function systemErrorTemplate(): string {
  return pick([
    `Sorry andi, chinna issue vachindi. Konchem sepatlo malli try cheyandi.`,
    `Andi, ee sari technical issue undi — please malli pampandi konchem sepu tarvata.`,
  ]);
}

// ── Sent when the customer asks to see the menu mid-conversation ─────────────

export function menuTemplate(restaurantName: string, menuText: string): string {
  return `Ee roju menu — *${restaurantName}*:\n\n${menuText}\n\nEnti kavalo cheppandi.`;
}
