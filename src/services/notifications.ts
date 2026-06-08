/**
 * All outbound WhatsApp message templates.
 * WhatsApp bold = *text*, italic = _text_. No markdown headers.
 */

export type NotifOrder = {
  id: number;
  type: string;
  total: number;
  note?: string | null;
  payment?: { method?: string | null; reference?: string | null; status?: string | null } | null;
  items: { qty: number; nameSnap: string; variantSnap?: string | null; priceSnap: number }[];
  customer: { name?: string | null; phone: string };
};

const TYPE_LABEL: Record<string, string> = {
  pickup: "Pickup",
  delivery: "Delivery",
  "dine-in": "Dine-in",
};

const STATUS_CONFIG: Record<string, { emoji: string; heading: string; body: string }> = {
  preparing: {
    emoji: "🍳",
    heading: "Being Prepared",
    body: "Your order is in the kitchen! We'll let you know as soon as it's ready.",
  },
  ready: {
    emoji: "✅",
    heading: "Ready for Pickup!",
    body: "Your order is ready at the counter. Please collect at your convenience 🙏",
  },
  delivered: {
    emoji: "🎉",
    heading: "Delivered!",
    body: "Thank you for ordering! Enjoy your meal 😊 Hope to see you again soon!",
  },
  cancelled: {
    emoji: "❌",
    heading: "Cancelled",
    body: "Your order has been cancelled. Please contact us if you have any questions.",
  },
};

function paymentLabel(order: NotifOrder): string {
  const m = order.payment?.method;
  if (!m) return `Cash on ${order.type === "delivery" ? "delivery" : "pickup"}`;
  const map: Record<string, string> = { upi: "UPI", cash: "Cash", card: "Card", online: "Online" };
  return map[m.toLowerCase()] ?? m;
}

function itemLines(order: NotifOrder): string {
  return order.items
    .map((i) => {
      const name = i.variantSnap ? `${i.nameSnap} (${i.variantSnap})` : i.nameSnap;
      return `  • ${i.qty}× ${name}  —  ₹${(i.priceSnap * i.qty).toFixed(0)}`;
    })
    .join("\n");
}

// ─── Sent to customer right after order is placed ───────────────────────────

export function orderConfirmationMsg(order: NotifOrder, restaurantName: string): string {
  const noteSection = order.note ? `\n📝 _Note: ${order.note}_` : "";
  return [
    `✅ *Order #${order.id} Confirmed!*`,
    "",
    `📋 *Your Order:*`,
    itemLines(order),
    "",
    `━━━━━━━━━━━━━━━━━━━━`,
    `💰 *Total: ₹${order.total.toFixed(0)}*`,
    `📦 Type: ${TYPE_LABEL[order.type] ?? order.type}`,
    `💵 Payment: ${paymentLabel(order)}${noteSection}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    "",
    `⏱ Ready in ~20-25 mins. We'll send you an update! 🙏`,
    `— _${restaurantName}_`,
  ].join("\n");
}

// ─── Sent to customer when admin changes order status ───────────────────────

export function orderStatusMsg(order: NotifOrder, status: string, restaurantName: string): string {
  const cfg = STATUS_CONFIG[status];
  if (!cfg) return "";

  const summary = order.items.map((i) => `${i.qty}× ${i.nameSnap}`).join(", ");

  return [
    `${cfg.emoji} *Order #${order.id} — ${cfg.heading}*`,
    "",
    cfg.body,
    "",
    `_${summary}_`,
    `💰 ₹${order.total.toFixed(0)}`,
    "",
    `— _${restaurantName}_`,
  ].join("\n");
}

// ─── Sent to owner(s) when a new order is placed ────────────────────────────

export function ownerNewOrderMsg(order: NotifOrder): string {
  const now = new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const customer = order.customer.name
    ? `${order.customer.name}  (${order.customer.phone})`
    : order.customer.phone;

  const noteSection = order.note ? `\n📝 _${order.note}_` : "";

  return [
    `🔔 *New Order #${order.id}!*`,
    "",
    `👤 ${customer}`,
    `📦 ${TYPE_LABEL[order.type] ?? order.type}  •  🕐 ${now}`,
    "",
    `📋 *Items:*`,
    itemLines(order),
    "",
    `━━━━━━━━━━━━━━━━━━━━`,
    `💰 *Total: ₹${order.total.toFixed(0)}*`,
    `💵 Payment: ${paymentLabel(order)}${noteSection}`,
  ].join("\n");
}

// ─── Sent to customer when Razorpay payment is received ─────────────────────

export function paymentReceivedMsg(order: NotifOrder, restaurantName: string): string {
  const ref = order.payment?.reference;
  const method = order.payment?.method ?? "online";

  return [
    `✅ *Payment Received!*`,
    "",
    `₹${order.total.toFixed(0)} received for Order #${order.id}`,
    `💳 Method: ${paymentLabel(order)}`,
    ref ? `🔖 Ref: ${ref}` : "",
    "",
    `🍳 Your order is confirmed and being prepared!`,
    `We'll send you an update when it's ready.`,
    "",
    `— _${restaurantName}_`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
