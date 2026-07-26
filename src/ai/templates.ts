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
  subtotal: number,
  type: string,
  note?: string,
  deliveryFee = 45,
): string {
  const typeLabel = TYPE_LABEL[type] ?? "Pickup";
  const noteLine = note ? `\n📝 Note: ${note}` : "";
  const itemList = items.map((i) => `• ${i}`).join("\n");
  const isDelivery = type === "delivery";
  const grandTotal = isDelivery ? subtotal + deliveryFee : subtotal;

  const costBreakdown = isDelivery
    ? `\n🍲 Items Subtotal: ₹${subtotal}\n🛵 Delivery Charge: ₹${deliveryFee}\n━━━━━━━━━━━━━━━━━━━━\n💰 Grand Total: ₹${grandTotal}`
    : `\n💰 Grand Total: ₹${subtotal}`;

  return [
    `🛒 *Order Summary:*`,
    itemList,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📦 *Type:* ${typeLabel}${costBreakdown}${noteLine}`,
    ``,
    `Tap *✅ Confirm & Pay* to place your order!`,
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

// ── Final bill, shown after the delivery fee is quoted and before paying ─────

export function finalBillTemplate(subtotal: number, deliveryFee: number): string {
  const total = subtotal + deliveryFee;
  return [
    `🧾 *Final Bill*`,
    ``,
    `Food Total: ₹${subtotal}`,
    `Delivery Fee: ₹${deliveryFee}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `*Total Amount: ₹${total}*`,
  ].join("\n");
}

// ── Razorpay could not produce a link; the owner is notified separately ──────

export function paymentUnavailableTemplate(): string {
  return `Sorry andi, payment link generate cheyyaledu 🙏 Manager ki inform chesaanu — konchem sepatlo meeku contact avthaaru.`;
}

// ── Sent when a customer claims they paid but Razorpay hasn't confirmed yet ──

export function paymentPendingTemplate(): string {
  return pick([
    `Payment inka raledu andi 🙏 Link lo pay chesthe, order automatic ga confirm avutundi.`,
    `Payment inka kanipinchaledu andi 🙏 Link lo complete chesthe, order confirm avutundi.`,
  ]);
}

// ── Sent after confirm_order places the order ────────────────────────────
// Note: a full itemized receipt is also sent automatically by session-manager.

export function orderConfirmedTemplate(): string {
  return pick([
    `Confirm chesam ✅ Receipt ippude pampistham.`,
    `Order confirm ayyindi ✅ Receipt vastundi konchem sepatlo.`,
  ]);
}

// ── Sent after cancel_order clears a staged (unconfirmed) cart ──────────────

export function orderCancelledTemplate(): string {
  return pick([
    `Order cancel chesam andi.`,
    `Sare andi, cancel chesam.`,
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
