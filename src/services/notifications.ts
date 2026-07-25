/**
 * All outbound WhatsApp message templates.
 * WhatsApp bold = *text*, italic = _text_. No markdown headers.
 */

export type NotifOrder = {
  id: number;
  type: string;
  subtotal?: number;
  deliveryFee?: number;
  deliveryAddress?: string | null;
  total: number;
  note?: string | null;
  payment?: { method?: string | null; reference?: string | null; status?: string | null } | null;
  items: { qty: number; nameSnap: string; variantSnap?: string | null; priceSnap: number }[];
  customer: { name?: string | null; phone: string };
  deliveryDispatch?: { providerCode?: string; status?: string; externalDeliveryId?: string | null; riderName?: string | null; riderPhone?: string | null } | null;
};

const TYPE_LABEL: Record<string, string> = {
  pickup:   "🏃 Pickup",
  delivery: "🛵 Delivery",
  "dine-in": "🍽️ Dine-in",
};

const STATUS_CONFIG: Record<string, { emoji: string; heading: string; body: string }> = {
  pending: {
    emoji: "🧾",
    heading: "Order Received",
    body: "We've got your order and it'll head to the kitchen shortly. We'll keep you posted! 🙏",
  },
  confirmed: {
    emoji: "👍",
    heading: "Order Confirmed",
    body: "Your order is confirmed and lined up for the kitchen. We'll update you as it progresses! 🙏",
  },
  preparing: {
    emoji: "🍳",
    heading: "Being Prepared",
    body: "Great news! Your order is in the kitchen and being freshly prepared. We'll ping you the moment it's ready! 🙏",
  },
  ready: {
    emoji: "✅",
    heading: "Ready for Pickup!",
    body: "Your order is ready and waiting at the counter. Come collect it at your convenience! 🎉",
  },
  delivered: {
    emoji: "🎉",
    heading: "Delivered!",
    body: "Hope you enjoy every bite! 😊 Thank you for ordering with us — we'd love to see you again soon!",
  },
  cancelled: {
    emoji: "❌",
    heading: "Order Cancelled",
    body: "Your order has been cancelled. We're sorry for the inconvenience. Please reach out if you have any questions.",
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
  const typeLabel = TYPE_LABEL[order.type] ?? order.type;
  const deliverySection = order.type === "delivery"
    ? `\n📍 *Delivery Address:* ${order.deliveryAddress || "Address requested"}\n🛵 *Delivery Fee:* ₹${(order.deliveryFee || 0).toFixed(0)}`
    : "";

  return [
    `✅ *Order #${order.id} Confirmed!*`,
    `_Thank you for ordering from ${restaurantName}!_`,
    "",
    `📋 *Items Ordered:*`,
    itemLines(order),
    "",
    `━━━━━━━━━━━━━━━━━━━━`,
    `💰 *Total: ₹${order.total.toFixed(0)}*${order.subtotal ? ` _(Subtotal: ₹${order.subtotal.toFixed(0)})_` : ""}`,
    `📦 *Type:* ${typeLabel}${deliverySection}`,
    `💵 *Payment:* ${paymentLabel(order)}${noteSection}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    "",
    `⏱ _Estimated time: ~25–35 mins. We'll update you on delivery status!_ 🙏`,
    "",
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
    `📋 _${summary}_`,
    `💰 ₹${order.total.toFixed(0)}`,
    "",
    `— _${restaurantName}_`,
  ].join("\n");
}

// ─── Sent to customer for live delivery updates ────────────────────────────

export function deliveryStatusMsg(
  orderId: number,
  status: string,
  riderName?: string | null,
  riderPhone?: string | null,
  trackingUrl?: string | null,
  restaurantName = "Godavari Ruchulu",
): string {
  const statusMessages: Record<string, { emoji: string; title: string; body: string }> = {
    COURIER_ASSIGNED: {
      emoji: "🛵",
      title: "Delivery Courier Assigned!",
      body: `Courier partner ${riderName ? `*${riderName}*` : ""} ${riderPhone ? `(${riderPhone})` : ""} has been assigned to pick up your order.`,
    },
    PICKED_UP: {
      emoji: "📦",
      title: "Order Picked Up!",
      body: "Your order has been picked up from the kitchen and is on its way to you! 🛵💨",
    },
    IN_TRANSIT: {
      emoji: "🛵",
      title: "Out for Delivery!",
      body: "Your courier is nearby and approaching your delivery location.",
    },
    DELIVERED: {
      emoji: "🎉",
      title: "Order Delivered!",
      body: "Your order has been successfully delivered. Enjoy your meal! 😊",
    },
  };

  const info = statusMessages[status];
  if (!info) return "";

  const trackingLine = trackingUrl ? `\n🔗 *Track Live:* ${trackingUrl}` : "";

  return [
    `${info.emoji} *Order #${orderId} — ${info.title}*`,
    "",
    info.body,
    trackingLine,
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
  const typeLabel = TYPE_LABEL[order.type] ?? order.type;
  const deliveryInfo = order.type === "delivery"
    ? `\n📍 *Delivery Address:* ${order.deliveryAddress || "Not specified"}\n🛵 *Delivery Fee:* ₹${(order.deliveryFee || 0).toFixed(0)}`
    : "";

  return [
    `🔔 *New Order #${order.id}!*`,
    "",
    `👤 *Customer:* ${customer}`,
    `📦 *Type:* ${typeLabel}  •  🕐 ${now}${deliveryInfo}`,
    "",
    `📋 *Items:*`,
    itemLines(order),
    "",
    `━━━━━━━━━━━━━━━━━━━━`,
    `💰 *Total: ₹${order.total.toFixed(0)}*`,
    `💵 *Payment:* ${paymentLabel(order)}${noteSection}`,
    `━━━━━━━━━━━━━━━━━━━━`,
  ].join("\n");
}

// ─── Sent to owner(s) when a customer requests a human ──────────────────────

export function ownerHandoffMsg(
  customer: { name?: string | null; phone: string },
  lastMessage?: string,
): string {
  const who = customer.name ? `${customer.name}  (${customer.phone})` : customer.phone;
  const msgLine = lastMessage ? `\n💬 _"${lastMessage.slice(0, 160)}"_` : "";
  return [
    `🙋 *Human requested!*`,
    "",
    `👤 *Customer:* ${who}${msgLine}`,
    "",
    `The AI is now *paused* for this chat. Open the dashboard → Chats to reply, then tap *Resume AI* when done.`,
  ].join("\n");
}

// ─── Sent to customer when Razorpay payment is received ─────────────────────

export function paymentReceivedMsg(order: NotifOrder, restaurantName: string): string {
  const ref = order.payment?.reference;

  return [
    `✅ *Payment Confirmed!*`,
    `_₹${order.total.toFixed(0)} received for Order #${order.id}_`,
    "",
    `💳 *Method:* ${paymentLabel(order)}`,
    ref ? `🔖 *Ref:* ${ref}` : "",
    "",
    `🍳 Your order is now *confirmed* and being freshly prepared!`,
    `We'll send you an update as soon as it's ready. 🙏`,
    "",
    `— _${restaurantName}_`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
