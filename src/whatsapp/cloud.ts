import type { WhatsAppAdapter, InboundMessage } from "./adapter.js";
import { logger } from '../services/logger.js';

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

  async sendText(phone: string, text: string): Promise<void> {
    const url = `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: text },
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      logger.error(`[Cloud ${this.phoneNumberId}] sendText failed (${resp.status}):`, err);
    }
  }

  /** Send a dish photo (by public URL) with an optional short caption. */
  async sendImage(phone: string, imageUrl: string, caption?: string): Promise<void> {
    const url = `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "image",
        image: { link: imageUrl, ...(caption ? { caption } : {}) },
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      logger.error(`[Cloud ${this.phoneNumberId}] sendImage failed (${resp.status}):`, err);
    }
  }

  /** POST a raw `interactive` block via the official Meta Graph API — same message types Kapso proxies. */
  private async sendInteractive(phone: string, interactive: Record<string, unknown>): Promise<void> {
    const url = `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phone,
        type: "interactive",
        interactive,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      logger.error(`[Cloud ${this.phoneNumberId}] sendInteractive (${interactive.type}) failed (${resp.status}):`, err);
      throw new Error(`Meta Cloud API sendInteractive (${interactive.type}) failed (${resp.status}): ${err}`);
    }
  }

  async sendInteractiveCtaUrl(
    phone: string,
    bodyText: string,
    buttonText: string,
    url: string,
  ): Promise<void> {
    const formattedUrl =
      url.includes("ngrok") && !url.includes("ngrok-skip-browser-warning")
        ? `${url}${url.includes("?") ? "&" : "?"}ngrok-skip-browser-warning=true`
        : url;

    await this.sendInteractive(phone, {
      type: "cta_url",
      body: { text: bodyText || "Tap below to open link in WhatsApp 👇" },
      action: {
        name: "cta_url",
        parameters: { display_text: buttonText.slice(0, 20), url: formattedUrl },
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
