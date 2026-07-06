/**
 * Fixed WhatsApp message templates for predictable bot responses.
 * WhatsApp formatting: *bold*, _italic_, ~strikethrough~, ```mono```
 * No markdown headers (#). Use emojis + spacing as visual separators.
 *
 * Each template uses pick() to randomly rotate phrasing so customers
 * never feel like they're talking to a robot reading from a script.
 */

/** Pick a random element from an array — for natural message variation. */
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const TYPE_LABEL: Record<string, string> = {
  pickup:   "🏃 Pickup",
  delivery: "🛵 Delivery",
  "dine-in": "🍽️ Dine-in",
};

// ── Sent after propose_order stages the cart ────────────────────────────────

export function orderStagedTemplate(
  items: string[],
  total: number,
  type: string,
  note?: string,
): string {
  const typeLabel = TYPE_LABEL[type] ?? "🏃 Pickup";
  const noteLine  = note ? `\n📝 _Note: ${note}_` : "";
  const itemList  = items.map((i) => `  • ${i}`).join("\n");

  const header = pick([
    `🛒 *Here's your order:*`,
    `📋 *Your order summary:*`,
    `✏️ *Got it! Here's what I have:*`,
    `🧾 *Order breakdown:*`,
  ]);

  const confirm = pick([
    `Tap *Confirm Order* below to proceed, or message me to add more items! 🛒`,
    `Tap *Confirm Order* to lock it in, or tell me what else to add! ✨`,
    `Tap *Confirm Order* below, or send a message to add more items! 😊`,
  ]);

  return [
    header,
    itemList,
    `━━━━━━━━━━━━━━━━━`,
    `💰 *Total: ₹${total}*`,
    `📦 *Type:* ${typeLabel}${noteLine}`,
    `━━━━━━━━━━━━━━━━━`,
    confirm,
  ].join("\n");
}

// ── Sent after generate_payment_link creates a Razorpay link ────────────────

export function paymentLinkTemplate(url: string, total: number): string {
  const opener = pick([
    `💳 *Time to pay!*`,
    `💳 *Almost there — just the payment left!*`,
    `🔒 *Secure payment*`,
    `💳 *One last step!*`,
  ]);

  const closer = pick([
    `✅ Your order *confirms automatically* once payment goes through!`,
    `✅ Payment done = order confirmed. That's it! 🎉`,
    `✅ We'll confirm your order the moment payment lands. 🙌`,
  ]);

  return (
    `${opener}\n\n` +
    `Please pay *₹${total}* using the link below:\n\n` +
    `${url}\n\n` +
    `${closer}\n` +
    `_Powered by Razorpay — safe & secure_ 🔐`
  );
}

// ── Sent after confirm_order places the order (manual UPI / cash path) ──────
// Note: a full itemized receipt is also sent automatically by session-manager.

export function orderConfirmedTemplate(): string {
  return pick([
    `✅ *Order confirmed!* You'll get a full receipt in just a sec. 🧾`,
    `✅ *Done! Order confirmed.* Hang tight — your receipt is on its way! 📋`,
    `✅ *You're all set!* Receipt coming up in a moment. 🎉`,
    `✅ *Order locked in!* We'll send your receipt right away. 🙏`,
  ]);
}

// ── Sent when the customer asks to see the menu mid-conversation ─────────────

export function menuTemplate(restaurantName: string, menuText: string): string {
  const opener = pick([
    `Here's our current menu at *${restaurantName}*:`,
    `Here's what we've got today at *${restaurantName}*:`,
    `Here's our menu:`,
    `Here's our current menu`,
  ]);
  return `${opener}\n\n${menuText}`;
}
