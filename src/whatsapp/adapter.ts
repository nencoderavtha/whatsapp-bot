/**
 * Meta WhatsApp Cloud API Adapter Interface.
 */
export interface InboundMessage {
  id?: string; // WhatsApp message ID for read receipts
  phone: string; // normalized digits, no "+"
  text: string;
  name?: string; // WhatsApp push name if available
  mediaType?: "text" | "audio" | "image";
  mediaUrl?: string;
  audioBuffer?: Buffer;
  mimeType?: string;
}

export interface WhatsAppAdapter {
  start(): Promise<void>;
  stop?(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  markRead?(messageId: string): Promise<void>;
  sendText(phone: string, text: string): Promise<void>;
  sendImage(phone: string, imageUrl: string, caption?: string): Promise<void>;
  sendInteractiveButtons?(
    phone: string,
    bodyText: string,
    buttons: { id: string; title: string }[],
    header?: { type: "text" | "image"; text?: string; imageUrl?: string } | string,
    footerText?: string,
  ): Promise<void>;
  sendInteractiveList?(
    phone: string,
    bodyText: string,
    buttonText: string,
    sections: { title: string; rows: { id: string; title: string; description?: string }[] }[],
    headerText?: string,
    footerText?: string,
  ): Promise<void>;
  sendInteractiveCarousel?(
    phone: string,
    bodyText: string,
    cards: Array<{
      title: string;
      desc?: string;
      imageUrl: string;
      buttonId: string;
      buttonTitle: string;
    }>,
  ): Promise<void>;
}

export const VOICE_NOTE_SENTINEL = "VOICE_NOTE_SENTINEL";
