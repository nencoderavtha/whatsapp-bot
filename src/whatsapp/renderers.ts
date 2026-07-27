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
  WELCOME = "WELCOME",
  CART_SUMMARY = "CART_SUMMARY",
  ADDRESS_PICKER = "ADDRESS_PICKER",
  ADDRESS_PIN_PROMPT = "ADDRESS_PIN_PROMPT",
  DELIVERY_QUOTE = "DELIVERY_QUOTE",
  PAYMENT_LINK = "PAYMENT_LINK",
  PAYMENT_LINK_VOIDED = "PAYMENT_LINK_VOIDED",
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

export function renderCartSummary(input: {
  items: string[];
  subtotal: number;
  stage: OrderStage;
  note?: string;
}): Rendered {
  const hint = cartHint(input.stage);
  const body = [
    input.items.map((i) => `• ${i}`).join("\n"),
    `━━━━━━━━━━━━━━━━━━━━`,
    `📦 *Type:* 🛵 Delivery`,
    `💰 *Items Total:* ₹${input.subtotal}${input.note ? `\n📝 Note: ${input.note}` : ""}`,
    ...(hint ? ["", hint] : []),
  ].join("\n");

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

export function renderDeliveryQuote(subtotal: number, deliveryFee: number): Rendered {
  return {
    kind: "text",
    body: [
      `🧾 *Final Bill*`,
      ``,
      `Food Total: ₹${subtotal}`,
      `Delivery Fee: ₹${deliveryFee}`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `*Total Amount: ₹${subtotal + deliveryFee}*`,
    ].join("\n"),
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

export function renderError(): Rendered {
  return {
    kind: "text",
    body: "Sorry andi, chinna issue vachindi. Konchem sepatlo malli try cheyandi.",
  };
}
