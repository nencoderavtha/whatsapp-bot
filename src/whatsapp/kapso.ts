import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import type { WhatsAppAdapter, InboundMessage } from "./adapter.js";

export class KapsoAdapter implements WhatsAppAdapter {
  private client: WhatsAppClient;
  private handler?: (msg: InboundMessage) => Promise<void>;

  constructor(
    private readonly phoneNumberId: string,
    private readonly apiKey: string,
  ) {
    // KapsoAdapter is dedicated to Kapso proxy routing. Direct Meta is handled by CloudAdapter.
    this.client = new WhatsAppClient({
      baseUrl: "https://app.kapso.ai/api/meta/",
      kapsoApiKey: apiKey,
    });
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    console.log(`✅ Kapso adapter ready (phoneNumberId=${this.phoneNumberId})`);
  }

  async ingest(msg: InboundMessage): Promise<void> {
    await this.handler?.(msg);
  }

  async sendText(phone: string, text: string): Promise<void> {
    await this.client.messages.sendText({
      phoneNumberId: this.phoneNumberId,
      to: phone,
      body: text,
    });
  }

  /** Send a dish photo (by public URL) with an optional short caption. */
  async sendImage(phone: string, imageUrl: string, caption?: string): Promise<void> {
    await this.client.messages.sendImage({
      phoneNumberId: this.phoneNumberId,
      to: phone,
      image: { link: imageUrl, ...(caption ? { caption } : {}) },
    });
  }

  async sendInteractiveCtaUrl(
    phone: string,
    bodyText: string,
    buttonText: string,
    url: string,
  ): Promise<void> {
    await this.client.messages.sendInteractiveCtaUrl({
      phoneNumberId: this.phoneNumberId,
      to: phone,
      bodyText,
      parameters: {
        displayText: buttonText,
        url,
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

    await this.client.messages.sendInteractiveButtons({
      phoneNumberId: this.phoneNumberId,
      to: phone,
      bodyText,
      buttons: buttons.map((b) => ({ id: b.id, title: b.title.slice(0, 20) })),
      ...(headerObj ? { header: headerObj } : {}),
      ...(footerText ? { footerText } : {}),
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
    await this.client.messages.sendInteractiveList({
      phoneNumberId: this.phoneNumberId,
      to: phone,
      bodyText,
      buttonText: buttonText.slice(0, 20),
      sections,
      ...(headerText ? { header: { type: "text", text: headerText } } : {}),
      ...(footerText ? { footerText } : {}),
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

    await this.client.messages.sendInteractiveButtons({
      phoneNumberId: this.phoneNumberId,
      to: phone,
      header: { type: "text", text: "💳 Complete Your Payment" },
      bodyText: body,
      footerText: `Secure UPI payment • Order #${orderId}`,
      buttons: [
        { id: `pay_confirm_${orderId}`, title: "✅ I've Paid" },
        { id: `pay_cancel_${orderId}`, title: "❌ Cancel Order" },
      ],
    });
  }

  /**
   * Send a native India-specific address collection form slide-up sheet.
   */
  async sendInteractiveAddress(
    phone: string,
    bodyText: string,
    prefill?: { name?: string; pinCode?: string; city?: string },
  ): Promise<void> {
    await this.client.messages.sendInteractiveAddress({
      phoneNumberId: this.phoneNumberId,
      to: phone,
      bodyText,
      parameters: {
        country: "IN",
        ...(prefill
          ? {
              values: {
                name: prefill.name ?? "",
                inPinCode: prefill.pinCode ?? "",
                city: prefill.city ?? "",
              },
            }
          : {}),
      },
    });
  }

  /**
   * Send a native location request message that allows sharing location in one tap.
   */
  async sendInteractiveLocationRequest(phone: string, bodyText: string): Promise<void> {
    await this.client.messages.sendInteractiveLocationRequest({
      phoneNumberId: this.phoneNumberId,
      to: phone,
      bodyText,
      parameters: {
        requestMessage: bodyText,
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
    await this.client.messages.sendInteractiveCarousel({
      phoneNumberId: this.phoneNumberId,
      to: phone,
      bodyText,
      cards: cards.map((c, idx) => ({
        cardIndex: idx,
        header: {
          type: "image",
          image: { link: c.imageUrl },
        },
        bodyText: `*${c.title}*\n${c.desc ?? ""}`,
        action: {
          buttons: [
            { id: c.buttonId, title: c.buttonTitle.slice(0, 20) },
          ],
        },
      })),
    });
  }
}
