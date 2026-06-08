import type { WhatsAppAdapter, InboundMessage } from "./adapter.js";

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
    console.log(`✅ Cloud adapter ready (phoneNumberId=${this.phoneNumberId})`);
  }

  // Called by botSessionManager.routeCloudMessage() when a webhook message arrives.
  async ingest(msg: InboundMessage): Promise<void> {
    await this.handler?.(msg);
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
      console.error(`[Cloud ${this.phoneNumberId}] sendText failed (${resp.status}):`, err);
    }
  }
}
