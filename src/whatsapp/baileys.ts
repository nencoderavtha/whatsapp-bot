import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import fs from "node:fs";
import type { WhatsAppAdapter, InboundMessage } from "./adapter.js";
import { notifyAdminOfEvent } from "../services/events.js";

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
  private stopped = false;
  // Remember the exact JID each customer messaged from (may be @lid, not the phone),
  // so we reply to the right address instead of guessing @s.whatsapp.net.
  private jidByPhone = new Map<string, string>();

  constructor(
    private authDir = "auth_session",
    private restaurantId?: number,
    private phoneNumber?: string,  // if set, uses pairing code instead of QR
  ) {}

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({ version, auth: state, logger });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const rid = this.restaurantId;
      if (qr) {
        if (this.phoneNumber) {
          // Pairing code mode: request a code instead of showing the QR
          try {
            const code = await sock.requestPairingCode(this.phoneNumber);
            console.log(`[r${rid ?? "?"}] Pairing code: ${code}`);
            console.log(`   → WhatsApp → Linked Devices → Link with phone number → enter code`);
            await notifyAdminOfEvent("pairing_code", { code, restaurantId: rid });
          } catch (e) {
            console.error(`[r${rid ?? "?"}] Pairing code failed, falling back to QR:`, e);
            console.log(`[r${rid ?? "?"}] QR ready — open the admin dashboard to scan.`);
            await notifyAdminOfEvent("qr_received", { qr, restaurantId: rid });
          }
        } else {
          // QR mode: send to admin dashboard
          console.log(`[r${rid ?? "?"}] QR ready — open the admin dashboard to scan.`);
          await notifyAdminOfEvent("qr_received", { qr, restaurantId: rid });
        }
      }
      if (connection === "open") {
        console.log(`[r${rid ?? "?"}] WhatsApp connected.`);
        await notifyAdminOfEvent("whatsapp_connected", { restaurantId: rid });
      }
      if (connection === "close") {
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
        await notifyAdminOfEvent("whatsapp_disconnected", { code, restaurantId: rid });
        if (code === DisconnectReason.loggedOut) {
          console.log(`[r${rid ?? "?"}] Logged out. Delete ${this.authDir}/ and re-scan from the dashboard.`);
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
        if (this.stopped) return; // intentional stop — don't reconnect
        console.log(`⚠️  Connection closed (code ${code}, restaurant ${this.restaurantId ?? ""}). Reconnecting...`);
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

  /** Disconnect and optionally wipe session files (forces fresh QR on next start). */
  async stop(clearSession = false): Promise<void> {
    this.stopped = true;
    try { this.sock?.end(undefined); } catch {}
    this.sock = undefined;
    if (clearSession && fs.existsSync(this.authDir)) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
      console.log(`[r${this.restaurantId ?? "?"}] Session files cleared from ${this.authDir}`);
    }
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
