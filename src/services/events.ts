import { EventEmitter } from "node:events";
import { config } from "../config.js";

export const eventBus = new EventEmitter();

// Global cache for WhatsApp connection state and latest QR code
export const whatsappState = {
  lastQR: null as string | null,
  connected: false,
};

/**
 * Emits an event locally and forwards it to the admin server's internal webhook
 * if this process is not the admin server.
 */
export async function notifyAdminOfEvent(type: string, data: any) {
  // Update local state cache
  if (type === "qr_received") {
    whatsappState.lastQR = data.qr;
    whatsappState.connected = false;
  } else if (type === "whatsapp_connected") {
    whatsappState.lastQR = null;
    whatsappState.connected = true;
  } else if (type === "whatsapp_disconnected") {
    whatsappState.lastQR = null;
    whatsappState.connected = false;
  }

  // Always emit locally (covers single-process mode)
  eventBus.emit("event", { type, data });

  // If this is NOT the admin server process, forward the event to the admin server
  if (process.env.IS_ADMIN_SERVER !== "true") {
    try {
      const url = `http://localhost:${config.adminPort}/api/internal/events`;
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": config.adminPassword,
        },
        body: JSON.stringify({ type, data }),
      });
    } catch (e) {
      // Ignore errors (e.g. admin server starting up or not running)
    }
  }
}

