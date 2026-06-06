/**
 * Provider-agnostic WhatsApp interface. The bot logic only depends on this,
 * so swapping Baileys <-> official Cloud API is a one-line change in run.ts.
 */
export interface WhatsAppAdapter {
  /** Start the connection (QR for Baileys, webhook server for Cloud). */
  start(): Promise<void>;
  /** Send a text message to a phone number (digits only, e.g. "919876543210"). */
  sendText(phone: string, text: string): Promise<void>;
  /** Show the "typing…" indicator to the customer (optional; no-op if unsupported). */
  setTyping?(phone: string, on: boolean): Promise<void>;
  /** Register the handler invoked on each inbound customer message. */
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
}

export interface InboundMessage {
  phone: string; // normalized digits, no "+"
  text: string;
  name?: string; // WhatsApp push name if available
}
