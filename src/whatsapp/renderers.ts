/**
 * Outbound message design system.
 *
 * The LLM classifies intent; it never writes customer-facing UI. Every message
 * the bot sends is one of the MessageType variants below, rendered here from
 * structured data. That keeps copy consistent, makes it reviewable in one file,
 * and stops the model inventing buttons or prices.
 *
 * Renderers return a descriptor rather than calling the adapter, so the caller
 * decides when to send and the shapes stay unit-testable.
 */

import type { OrderStage } from "@prisma/client";

export enum MessageType {
  CART_SUMMARY = "CART_SUMMARY",
  ADDRESS_PICKER = "ADDRESS_PICKER",
  ADDRESS_PIN_PROMPT = "ADDRESS_PIN_PROMPT",
  DELIVERY_QUOTE = "DELIVERY_QUOTE",
  PAYMENT_LINK = "PAYMENT_LINK",
  PAYMENT_LINK_VOIDED = "PAYMENT_LINK_VOIDED",
  PAYMENT_FAILED = "PAYMENT_FAILED",
  FAQ_REPLY = "FAQ_REPLY",
  ERROR = "ERROR",
}

export interface Button {
  id: string;
  title: string;
}

/** A message to send, independent of which WhatsApp primitive carries it. */
export type Rendered =
  | { kind: "text"; body: string }
  | { kind: "buttons"; body: string; buttons: Button[]; header?: string; footer?: string }
  | { kind: "cta"; body: string; buttonTitle: string; url: string };

// ── Welcome ─────────────────────────────────────────────────────────────────

/** What `buildWelcomeCard` hands back — the caller decides how to send each part. */
export interface WelcomeCard {
  /** If set, the caller sends this via `sendImage()` first — list messages can't carry an image header. */
  logoUrl?: string;
  body: string;
  buttonText: string;
  sections: { title: string; rows: { id: string; title: string; description?: string }[] }[];
}

/**
 * The welcome "card" sent on a greeting, before any database work touches the
 * customer row. Everything it needs is either on the inbound message (the
 * WhatsApp profile name), cached restaurant config, or the two lightweight
 * queries the caller runs alongside the cache read (menu categories, active
 * coupon) — so it still goes out without waiting on a customer lookup.
 *
 * WhatsApp reply-buttons cap at three; this needs four CTAs, so it renders as
 * a list message (`sections`) instead. List messages can't show an image
 * header, which is why the logo (if any) travels as a separate `sendImage`
 * call the caller fires immediately before this.
 */
export function buildWelcomeCard(params: {
  greetName: string;
  restaurantName: string;
  tagline?: string | null;
  isOpen: boolean;
  pauseMessage?: string | null;
  openingHoursText?: string | null;
  activeCoupon?: { code: string; description?: string | null } | null;
  categoryNames: string[];
  logoUrl?: string | null;
}): WelcomeCard {
  const lines: string[] = [
    `Namaskaram ${params.greetName} 🙏`,
    ``,
    `*${params.restaurantName}* ki welcome! 🎉`,
  ];

  if (params.tagline?.trim()) lines.push(`_${params.tagline.trim()}_`);

  lines.push(``);
  if (params.isOpen) {
    lines.push(`🟢 *We're open right now!*`);
    if (params.openingHoursText?.trim()) lines.push(`🕒 ${params.openingHoursText.trim()}`);
  } else {
    lines.push(`🔴 *We're closed right now.*`);
    lines.push(params.pauseMessage?.trim() || "We'll be back shortly — thanks for your patience 🙏");
  }

  if (params.activeCoupon) {
    const desc = params.activeCoupon.description?.trim();
    lines.push(``, `🎁 *Offer:* Code *${params.activeCoupon.code}*${desc ? ` — ${desc}` : ""}`);
  }

  lines.push(``, `👇 Menu chuudandi, leda em kavalo cheppandi — order start chestham.`);

  if (params.categoryNames.length > 0) {
    lines.push(``, `🍴 *Popular:* ${params.categoryNames.slice(0, 5).join(", ")}`);
  }

  return {
    ...(params.logoUrl ? { logoUrl: params.logoUrl } : {}),
    body: lines.join("\n"),
    buttonText: "View Options",
    sections: [
      {
        title: "Quick Actions",
        rows: [
          { id: "view_menu", title: "🍽 Browse Menu", description: "See today's full menu" },
          { id: "start_ordering_btn", title: "🛒 Start Ordering", description: "Jump straight into ordering" },
          { id: "track_order_btn", title: "📍 Track Order", description: "Check your latest order status" },
          { id: "talk_to_human_btn", title: "💬 Talk to Human", description: "Chat with our staff" },
        ],
      },
    ],
  };
}

// ── Cart ────────────────────────────────────────────────────────────────────

/**
 * The trailing hint is stage-aware. Repeating "delivery fee is added after you
 * pin a location" once an address is already on file reads like the bot has
 * forgotten the conversation.
 */
function cartHint(stage: OrderStage): string {
  switch (stage) {
    case "BUILDING_CART":
      return "_Delivery fee location pin chesaka add avutundi._";
    case "ADDRESS_SELECTED":
      return "_Address set ayyindi. Confirm chesthe final bill chupistham._";
    case "QUOTE_GENERATED":
    case "AWAITING_PAYMENT":
      return "_Cart update ayyindi — kotha bill chupistham._";
    default:
      return "";
  }
}

/**
 * The cart summary body on its own, for callers that supply their own buttons
 * (the AI tool path returns a templateReply string rather than a descriptor).
 */
export function cartSummaryText(
  items: string[],
  subtotal: number,
  stage: OrderStage,
  note?: string,
): string {
  const hint = cartHint(stage);
  return [
    items.map((i) => `• ${i}`).join("\n"),
    `━━━━━━━━━━━━━━━━━━━━`,
    `📦 *Type:* 🛵 Delivery`,
    `💰 *Items Total:* ₹${subtotal}${note ? `\n📝 Note: ${note}` : ""}`,
    ...(hint ? ["", hint] : []),
  ].join("\n");
}

export function renderCartSummary(input: {
  items: string[];
  subtotal: number;
  stage: OrderStage;
  note?: string;
}): Rendered {
  const body = cartSummaryText(input.items, input.subtotal, input.stage, input.note);

  return {
    kind: "buttons",
    body,
    header: "🛒 Order Summary",
    buttons: [
      { id: "confirm_order_btn", title: "✅ Confirm Order" },
      { id: "add_more_items_btn", title: "➕ Add More Items" },
    ],
  };
}

// ── Address ─────────────────────────────────────────────────────────────────

export function renderAddressPicker(addresses: string[]): Rendered {
  // WhatsApp allows three reply buttons; two saved addresses plus a new one.
  const shortlist = addresses.slice(0, 2);
  return {
    kind: "buttons",
    header: "📦 Delivery Location",
    body: `Ekkada deliver cheyyamantaru andi?\n\n${shortlist.map((a, i) => `${i + 1}. ${a}`).join("\n\n")}`,
    buttons: [
      ...shortlist.map((addr, i) => ({ id: `use_addr_${i}`, title: `📍 ${addr.slice(0, 18)}` })),
      { id: "pin_new_location_btn", title: "🗺️ New Address" },
    ],
  };
}

export function renderAddressPinPrompt(mapUrl: string): Rendered {
  return {
    kind: "cta",
    body: "Ee link lo mee location pin drop cheyandi 👇",
    buttonTitle: "📍 Drop Location on Maps",
    url: mapUrl,
  };
}

// ── Money ───────────────────────────────────────────────────────────────────

/**
 * The bill a customer approves before paying. It itemises and names the drop
 * address — this is the last screen before money moves, so "Food Total: ₹350"
 * with no indication of what or where was asking them to pay on trust.
 */
export function renderDeliveryQuote(input: {
  items: string[];
  subtotal: number;
  deliveryFee: number;
  address?: string | null;
}): Rendered {
  const lines = [
    `🧾 *Final Bill*`,
    ``,
    ...input.items.map((i) => `• ${i}`),
    `━━━━━━━━━━━━━━━━━━━━`,
    `Food Total: ₹${input.subtotal}`,
    `Delivery Fee: ₹${input.deliveryFee}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `*Total Amount: ₹${input.subtotal + input.deliveryFee}*`,
  ];

  if (input.address) {
    lines.push(``, `📍 *Delivering to:*`, input.address);
  }

  return { kind: "text", body: lines.join("\n") };
}

/**
 * Answers "which address is this going to?" from stored state instead of
 * letting the model guess. It previously replied that no address was set while
 * one was on file and a payment link had already been issued.
 */
export function renderCurrentAddress(address: string): Rendered {
  return {
    kind: "buttons",
    header: "📦 Delivery Address",
    body: `Ee address ki deliver chesthunnam andi:\n\n📍 ${address}`,
    buttons: [
      { id: "confirm_order_btn", title: "✅ Correct" },
      { id: "pin_new_location_btn", title: "🗺️ Change Address" },
    ],
  };
}

/**
 * Offer one dish alongside what the customer just added.
 *
 * Sent as its own message rather than appended to the cart summary: the summary
 * is what they asked for and carries the confirm button, and burying an offer
 * inside it makes the total harder to read. A separate bubble is also ignorable,
 * which an upsell should be.
 *
 * The Add button is a normal menu_item_<id>, so it goes through the same handler
 * as a tap from the menu — including asking which variant when the dish has them.
 */
export function renderPairingSuggestion(input: {
  itemId: number;
  name: string;
  priceLabel: string;
  pitch: string;
}): Rendered {
  return {
    kind: "buttons",
    body: `${input.pitch}\n\n*${input.name}* — ${input.priceLabel}`,
    buttons: [{ id: `menu_item_${input.itemId}`, title: "➕ Add" }],
  };
}

export function renderPaymentLink(url: string, total: number): Rendered {
  return {
    kind: "cta",
    body: "Pay ayyaka order confirm avutundi.",
    buttonTitle: `💳 Pay ₹${total}`,
    url,
  };
}

/**
 * Sent when a cart edit invalidates a payment link the customer already has.
 * Without this they keep a live-looking link for a total that no longer applies.
 */
export function renderPaymentLinkVoided(): Rendered {
  return {
    kind: "text",
    body: "Cart change chesaru kabatti mundu pampina payment link cancel ayyindi andi 🙏 Kotha link ippude pampistham.",
  };
}

/**
 * Sent when Razorpay reports the link cancelled or expired.
 *
 * Silence here is what stranded customers: their link stopped working, the cart
 * still existed, and nothing in the chat said so or offered a way forward. The
 * cart is untouched, so the button retries payment on the same order.
 */
export function renderPaymentFailed(): Rendered {
  return {
    kind: "buttons",
    header: "💳 Payment Incomplete",
    body: "Payment complete kaledu andi 🙏 Mee cart intact ga undi — malli try cheyyochu.",
    buttons: [
      { id: "confirm_order_btn", title: "🔁 Retry Payment" },
      { id: "add_more_items_btn", title: "✏️ Edit Order" },
    ],
  };
}

export function renderError(): Rendered {
  return {
    kind: "text",
    body: "Sorry andi, chinna issue vachindi. Konchem sepatlo malli try cheyandi.",
  };
}
