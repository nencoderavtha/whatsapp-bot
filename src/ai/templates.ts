/**
 * Fixed WhatsApp message templates for predictable bot responses.
 * Edit the strings here to customise what the bot says — no prompt changes needed.
 */

const TYPE_LABEL: Record<string, string> = {
  pickup:   "Pickup",
  delivery: "Delivery",
  "dine-in": "Dine-in",
};

// ── Sent as the very first reply to any new customer ────────────────────────

export function greetingTemplate(
  restaurantName: string,
  customerName: string | undefined,
  menuText: string,
): string {
  const hi = customerName
    ? `Hi *${customerName}!* 👋 I can help you order anything from *${restaurantName}*'s menu.`
    : `Hi! 👋 I can help you order anything from *${restaurantName}*'s menu.`;
  return `${hi}\n\nHere's our menu:\n\n${menuText}\n\nWhat would you like to order?`;
}

// ── Sent after propose_order stages the cart ────────────────────────────────

export function orderStagedTemplate(
  items: string[],
  total: number,
  type: string,
  note?: string,
): string {
  const typeLabel = TYPE_LABEL[type] ?? "Pickup";
  const noteLine  = note ? `\n📝 _Note: ${note}_` : "";
  return (
    `Here's your order:\n\n` +
    items.map((i) => `  • ${i}`).join("\n") +
    `\n\n*Total: ₹${total}* (${typeLabel})${noteLine}\n\n` +
    `Shall I confirm this? ✅`
  );
}

// ── Sent after generate_payment_link creates a Razorpay link ────────────────

export function paymentLinkTemplate(url: string, total: number): string {
  return (
    `Please pay *₹${total}* using the link below:\n\n` +
    `${url}\n\n` +
    `Your order will be *confirmed automatically* once payment is done! 🎉`
  );
}

// ── Sent after confirm_order places the order (manual UPI / cash path) ──────
// Note: a full itemized receipt is also sent automatically by session-manager.

export function orderConfirmedTemplate(): string {
  return `✅ Order confirmed! You'll receive a detailed receipt in a moment.`;
}

// ── Sent when the customer asks to see the menu mid-conversation ─────────────

export function menuTemplate(restaurantName: string, menuText: string): string {
  return `Here's our current menu at *${restaurantName}*:\n\n${menuText}`;
}
