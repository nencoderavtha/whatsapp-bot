import express from "express";
import { config } from "../config.js";
import type { WhatsAppAdapter, InboundMessage } from "./adapter.js";

/**
 * Official Meta WhatsApp Cloud API adapter.
 * Receives messages via webhook and sends via the Graph API.
 * Run this when WHATSAPP_PROVIDER=cloud. Point your Meta webhook at /webhook.
 */
export class CloudAdapter implements WhatsAppAdapter {
  private handler?: (msg: InboundMessage) => Promise<void>;
  private app = express();
  private port = config.adminPort + 1; // separate port from admin portal

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.app.use(express.json());

    // Webhook verification handshake.
    this.app.get("/webhook", (req, res) => {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === config.cloud.verifyToken) {
        res.status(200).send(challenge);
      } else {
        res.sendStatus(403);
      }
    });

    // Inbound messages.
    this.app.post("/webhook", async (req, res) => {
      res.sendStatus(200); // ack fast
      try {
        const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
        const msg = entry?.messages?.[0];
        if (!msg) return;
        const text =
          msg.text?.body ?? msg.button?.text ?? msg.interactive?.list_reply?.title ?? "";
        if (!text.trim()) return;
        const inbound: InboundMessage = {
          phone: msg.from,
          text: text.trim(),
          name: entry?.contacts?.[0]?.profile?.name,
        };
        await this.handler?.(inbound);
      } catch (e) {
        console.error("Cloud webhook error:", e);
      }
    });

    await new Promise<void>((resolve) =>
      this.app.listen(this.port, () => {
        console.log(`✅ Cloud API webhook listening on :${this.port}/webhook`);
        resolve();
      }),
    );
  }

  async sendText(phone: string, text: string): Promise<void> {
    const url = `https://graph.facebook.com/v21.0/${config.cloud.phoneNumberId}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.cloud.token}`,
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
      console.error("Cloud send failed:", resp.status, await resp.text());
    }
  }
}
