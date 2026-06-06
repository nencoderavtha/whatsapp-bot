import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import pino from "pino";
import type { WhatsAppAdapter, InboundMessage } from "./adapter.js";
import { notifyAdminOfEvent } from "../services/events.js";

const AUTH_DIR = "auth_session";
// Baileys is very chatty and logs harmless "Bad MAC" / decryption / timeout errors at
// error level. We silence its internal logger and rely on our own connection logs below.
const logger = pino({ level: "silent" });

/** Strip the WhatsApp JID down to digits ("919876543210@s.whatsapp.net" -> "919876543210"). */
function jidToPhone(jid: string): string {
  return jid.split("@")[0].split(":")[0];
}

export class BaileysAdapter implements WhatsAppAdapter {
  private sock?: WASocket;
  private handler?: (msg: InboundMessage) => Promise<void>;
  // Remember the exact JID each customer messaged from (may be @lid, not the phone),
  // so we reply to the right address instead of guessing @s.whatsapp.net.
  private jidByPhone = new Map<string, string>();

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({ version, auth: state, logger });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log("\n📱 Scan this QR with WhatsApp (Linked Devices):\n");
        qrcode.generate(qr, { small: true });
        await notifyAdminOfEvent("qr_received", { qr });
      }
      if (connection === "open") {
        console.log("✅ WhatsApp connected.");
        await notifyAdminOfEvent("whatsapp_connected", {});
      }
      if (connection === "close") {
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
        await notifyAdminOfEvent("whatsapp_disconnected", { code });
        if (code === DisconnectReason.loggedOut) {
          console.log("⚠️  Logged out. Delete the auth_session/ folder and re-scan the QR.");
          return; // don't reconnect — credentials are gone
        }
        if (code === DisconnectReason.connectionReplaced) {
          // 440: the same WhatsApp account got linked somewhere else. Reconnecting here
          // just fights that other session in an endless loop — so stop and tell the user.
          console.log(
            "\n🛑 Connection replaced (code 440): this WhatsApp account is active in another session.\n" +
              "   You likely have the bot running in TWO places, or WhatsApp Web open with this number.\n" +
              "   Close the other one, then run the bot again (just once).\n",
          );
          process.exit(1);
        }
        console.log(`⚠️  Connection closed (code ${code}). Reconnecting...`);
        this.start();
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid ?? "";
        if (jid.endsWith("@g.us") || jid === "status@broadcast") continue; // skip groups/status

        // Unwrap ephemeral/view-once envelopes so we still find the text inside.
        const content =
          m.message.ephemeralMessage?.message ??
          m.message.viewOnceMessage?.message ??
          m.message.viewOnceMessageV2?.message ??
          m.message;
        const text =
          content.conversation ??
          content.extendedTextMessage?.text ??
          content.imageMessage?.caption ??
          "";
        if (!text.trim()) {
          console.log(`(ignored non-text message from ${jid})`);
          continue;
        }

        const phone = jidToPhone(jid);
        this.jidByPhone.set(phone, jid); // reply to this exact address
        const inbound: InboundMessage = {
          phone,
          text: text.trim(),
          name: m.pushName ?? undefined,
        };
        try {
          await sock.sendPresenceUpdate("composing", jid);
        } catch {}
        await this.handler?.(inbound);
      }
    });
  }

  /** The exact JID to reply to (stored from the inbound message), else best-guess. */
  private jidFor(phone: string): string {
    return this.jidByPhone.get(phone) ?? `${phone}@s.whatsapp.net`;
  }

  async setTyping(phone: string, on: boolean): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate(on ? "composing" : "paused", this.jidFor(phone));
    } catch {}
  }

  async sendText(phone: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("Baileys not connected yet");
    const jid = this.jidFor(phone);
    try {
      await this.sock.sendMessage(jid, { text });
      console.log(`✉️  sent to ${jid}: ${text.slice(0, 60)}`);
    } catch (e) {
      console.error(`❌ failed to send to ${jid}:`, e);
      throw e;
    }
  }
}
