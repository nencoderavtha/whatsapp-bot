import type { WhatsAppAdapter, InboundMessage } from "./adapter.js";
import { logger } from '../services/logger.js';
import { logOutboundMessage } from "../services/customer.js";

/**
 * Flatten an outgoing Meta payload into the line staff should see in the
 * dashboard.
 *
 * The body text alone loses what the message actually was: a cart summary and
 * a payment prompt can read almost identically until you can see that one
 * carried a "Pay now" button. The affordances are appended so a staff member
 * reading the thread knows what the customer was looking at when they replied
 * with a tap.
 */
export function transcriptOf(payload: Record<string, unknown>): string {
  const type = payload.type as string;

  if (type === "text") {
    return String((payload.text as any)?.body ?? "");
  }

  if (type === "image") {
    const caption = (payload.image as any)?.caption;
    return caption ? `🖼 ${caption}` : "🖼 [photo]";
  }

  if (type !== "interactive") return `[${type}]`;

  const i = payload.interactive as any;
  const body = String(i?.body?.text ?? "").trim();
  const action = i?.action ?? {};
  let affordance = "";

  switch (i?.type) {
    case "button":
      affordance = `[Buttons: ${(action.buttons ?? [])
        .map((b: any) => b.reply?.title)
        .filter(Boolean)
        .join(" | ")}]`;
      break;
    case "list": {
      const rows = (action.sections ?? []).flatMap((s: any) => s.rows ?? []);
      affordance = `[List "${action.button}": ${rows.length} option(s)]`;
      break;
    }
    case "cta_url":
      affordance = `[Link "${action.parameters?.display_text}": ${action.parameters?.url}]`;
      break;
    case "carousel":
      affordance = `[Carousel: ${(action.cards ?? []).length} card(s)]`;
      break;
    case "location_request_message":
      affordance = "[Share location button]";
      break;
    case "address_message":
      affordance = "[Address form]";
      break;
    default:
      affordance = `[${i?.type}]`;
  }

  return body ? `${body}\n${affordance}` : affordance;
}

/**
 * Official Meta WhatsApp Cloud API adapter — one instance per restaurant.
 *
 * The admin server's /webhook route handles ALL inbound messages and calls
 * ingest() on the right adapter. This adapter never starts its own HTTP server.
 */
export class CloudAdapter implements WhatsAppAdapter {
  private handler?: (msg: InboundMessage) => Promise<void>;

  constructor(
    private readonly phoneNumberId: string,
    private readonly token: string,
  ) {}

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  // No socket to open — webhook is centralized.
  async start(): Promise<void> {
    logger.info(`✅ Cloud adapter ready (phoneNumberId=${this.phoneNumberId})`);
  }

  // Called by botSessionManager.routeCloudMessage() when a webhook message arrives.
  async ingest(msg: InboundMessage): Promise<void> {
    await this.handler?.(msg);
  }

  async markRead(messageId: string): Promise<void> {
    const url = `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      logger.error(`[Cloud ${this.phoneNumberId}] markRead failed (${resp.status}):`, err);
    }
  }

  /**
   * The only path to the Graph API for anything the customer will read.
   *
   * Recording the transcript here rather than at each call site is the point:
   * there are dozens of send call sites across the session manager and the
   * renderers, and every one that forgot to log left a hole in the dashboard.
   * A new message type added later is recorded without anyone remembering to.
   */
  private async post(
    phone: string,
    payload: Record<string, unknown>,
    label: string,
    throwOnError = false,
  ): Promise<void> {
    const url = `https://graph.facebook.com/v24.0/${this.phoneNumberId}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to: phone, ...payload }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      logger.error(`[Cloud ${this.phoneNumberId}] ${label} failed (${resp.status}):`, err);
      if (throwOnError) {
        throw new Error(`Meta Cloud API ${label} failed (${resp.status}): ${err}`);
      }
      // A message that never arrived must not appear in the transcript as sent.
      return;
    }

    await logOutboundMessage(phone, transcriptOf(payload));
  }

  async sendText(phone: string, text: string): Promise<void> {
    await this.post(phone, { type: "text", text: { body: text } }, "sendText");
  }

  /** Send a dish photo (by public URL) with an optional short caption. */
  async sendImage(phone: string, imageUrl: string, caption?: string): Promise<void> {
    await this.post(
      phone,
      { type: "image", image: { link: imageUrl, ...(caption ? { caption } : {}) } },
      "sendImage",
    );
  }

  /** POST a raw `interactive` block via the official Meta Graph API — same message types Kapso proxies. */
  private async sendInteractive(phone: string, interactive: Record<string, unknown>): Promise<void> {
    await this.post(
      phone,
      { recipient_type: "individual", type: "interactive", interactive },
      `sendInteractive (${interactive.type})`,
      true,
    );
  }

  async sendInteractiveCtaUrl(
    phone: string,
    bodyText: string,
    buttonText: string,
    url: string,
  ): Promise<void> {
    await this.sendInteractive(phone, {
      type: "cta_url",
      body: { text: bodyText || "Tap below to open link in WhatsApp 👇" },
      action: {
        name: "cta_url",
        parameters: { display_text: buttonText.slice(0, 20), url },
      },
    });
  }

  async sendInteractiveButtons(
    phone: string,
    bodyText: string,
    buttons: { id: string; title: string }[],
    header?: { type: "text" | "image"; text?: string; imageUrl?: string } | string,
    footerText?: string,
  ): Promise<void> {
    let headerObj: any = undefined;
    if (typeof header === "string") {
      headerObj = { type: "text", text: header };
    } else if (header && typeof header === "object") {
      if (header.type === "image" && header.imageUrl) {
        headerObj = { type: "image", image: { link: header.imageUrl } };
      } else if (header.type === "text" && header.text) {
        headerObj = { type: "text", text: header.text };
      }
    }

    await this.sendInteractive(phone, {
      type: "button",
      body: { text: bodyText },
      ...(headerObj ? { header: headerObj } : {}),
      ...(footerText ? { footer: { text: footerText } } : {}),
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    });
  }

  /**
   * Send a native WhatsApp interactive list message.
   * Users tap the list button and a modal sheet slides up showing all sections/rows — no browser needed.
   */
  async sendInteractiveList(
    phone: string,
    bodyText: string,
    buttonText: string,
    sections: { title: string; rows: { id: string; title: string; description?: string }[] }[],
    headerText?: string,
    footerText?: string,
  ): Promise<void> {
    await this.sendInteractive(phone, {
      type: "list",
      body: { text: bodyText },
      ...(headerText ? { header: { type: "text", text: headerText } } : {}),
      ...(footerText ? { footer: { text: footerText } } : {}),
      action: {
        button: buttonText.slice(0, 20),
        sections: sections.map((s) => ({
          title: s.title,
          rows: s.rows.map((r) => ({
            id: r.id,
            title: r.title,
            ...(r.description ? { description: r.description } : {}),
          })),
        })),
      },
    });
  }

  /**
   * Send a payment confirmation message as an interactive button message.
   * Stays entirely inside WhatsApp — shows UPI details in body + confirm/cancel buttons.
   */
  async sendPaymentDetails(
    phone: string,
    upiId: string,
    upiName: string,
    amount: string,
    txnNote: string,
    orderId: number,
  ): Promise<void> {
    const amountLine = amount ? `💰 *Amount:* ₹${amount}` : "";
    const body = [
      `🧾 *Payment Details*`,
      ``,
      `🏪 *Pay to:* ${upiName}`,
      `📱 *UPI ID:* \`${upiId}\``,
      amountLine,
      `📝 *Note:* ${txnNote || `Order #${orderId}`}`,
      ``,
      `Open your UPI app (GPay, PhonePe, Paytm) and pay to the UPI ID above.`,
    ].filter(Boolean).join("\n");

    await this.sendInteractiveButtons(
      phone,
      body,
      [
        { id: `pay_confirm_${orderId}`, title: "✅ I've Paid" },
        { id: `pay_cancel_${orderId}`, title: "❌ Cancel Order" },
      ],
      "💳 Complete Your Payment",
      `Secure UPI payment • Order #${orderId}`,
    );
  }

  /**
   * Send a native India-specific address collection form slide-up sheet.
   */
  async sendInteractiveAddress(
    phone: string,
    bodyText: string,
    prefill?: { name?: string; pinCode?: string; city?: string },
  ): Promise<void> {
    await this.sendInteractive(phone, {
      type: "address_message",
      body: { text: bodyText },
      action: {
        name: "address_message",
        parameters: {
          country: "IN",
          ...(prefill
            ? {
                values: {
                  name: prefill.name ?? "",
                  in_pin_code: prefill.pinCode ?? "",
                  city: prefill.city ?? "",
                },
              }
            : {}),
        },
      },
    });
  }

  /**
   * Send a native location request message that allows sharing location in one tap.
   */
  async sendInteractiveLocationRequest(phone: string, bodyText: string): Promise<void> {
    await this.sendInteractive(phone, {
      type: "location_request_message",
      body: { text: bodyText },
      action: {
        name: "send_location",
        parameters: { request_message: bodyText },
      },
    });
  }

  /**
   * Send a swipeable horizontal carousel of custom cards.
   */
  async sendInteractiveCarousel(
    phone: string,
    bodyText: string,
    cards: Array<{
      title: string;
      desc?: string;
      imageUrl: string;
      buttonId: string;
      buttonTitle: string;
    }>,
  ): Promise<void> {
    await this.sendInteractive(phone, {
      type: "carousel",
      body: { text: bodyText },
      action: {
        cards: cards.map((c, idx) => {
          const bodyLine = `*${c.title}*\n${c.desc ?? ""}`.slice(0, 160);
          return {
            card_index: idx,
            header: { type: "image", image: { link: c.imageUrl } },
            body: { text: bodyLine },
            action: {
              buttons: [
                { type: "quick_reply", quick_reply: { id: c.buttonId, title: c.buttonTitle.slice(0, 20) } },
              ],
            },
          };
        }),
      },
    });
  }
}
