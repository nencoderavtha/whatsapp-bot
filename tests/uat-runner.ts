import { CloudAdapter } from "../src/whatsapp/cloud.js";
import { botSessionManager } from "../src/whatsapp/session-manager.js";
import type { InboundMessage } from "../src/whatsapp/adapter.js";
import { prisma } from "../src/db.js";
import { logger } from '../src/services/logger.js';

export class MockWhatsAppAdapter extends CloudAdapter {
  public outboundLog: any[] = [];
  
  constructor(config: any) {
    super(config);
  }

  async sendText(phone: string, text: string): Promise<void> {
    this.outboundLog.push({ type: "text", text });
  }

  async sendImage(phone: string, imageUrl: string, caption?: string): Promise<void> {
    this.outboundLog.push({ type: "image", imageUrl, caption });
  }

  async sendInteractiveButtons(
    phone: string,
    bodyText: string,
    buttons: { id: string; title: string }[],
    header?: any,
    footerText?: string
  ): Promise<void> {
    this.outboundLog.push({ type: "buttons", bodyText, buttons });
  }

  async sendInteractiveList(
    phone: string,
    bodyText: string,
    buttonText: string,
    sections: any[],
    headerText?: string,
    footerText?: string
  ): Promise<void> {
    this.outboundLog.push({ type: "list", bodyText, sections });
  }

  async sendInteractiveCarousel(
    phone: string,
    bodyText: string,
    cards: any[]
  ): Promise<void> {
    this.outboundLog.push({ type: "carousel", bodyText, cards });
  }

  async sendInteractiveCtaUrl(
    phone: string,
    bodyText: string,
    buttonText: string,
    url: string
  ): Promise<void> {
    this.outboundLog.push({ type: "cta_url", bodyText, url });
  }

  async sendLocationRequest(phone: string, bodyText: string): Promise<void> {
    this.outboundLog.push({ type: "location_request", bodyText });
  }

  async sendImage(phone: string, imageUrl: string, caption?: string): Promise<void> {
    this.outboundLog.push({ type: "image", imageUrl, caption });
  }

  clearLog() {
    this.outboundLog = [];
  }
}

export class UatTestRunner {
  private adapter: MockWhatsAppAdapter;
  private phone = "910000000000"; // Test customer phone

  constructor() {
    this.adapter = new MockWhatsAppAdapter({
      whatsappToken: "mock-token",
      whatsappPhoneId: "mock-phone",
      kapsoApiKey: undefined,
    });
  }

  async init() {
    // Inject the mock adapter directly into the session manager for restaurant 1
    const config = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });
    if (!config) throw new Error("Restaurant config not found");
    
    // We start the session using the normal flow, but pass our custom adapter so outbound calls are intercepted
    botSessionManager.stopSession(1);
    await botSessionManager.startSession(1, config.restaurantName, this.adapter);
    
    (botSessionManager as any).sessions.set(1, this.adapter);
    
    // Clear out any previous pending orders and reset human handoff state for this phone number
    const cust = await prisma.customer.findUnique({ where: { phone: this.phone } });
    if (cust) {
      await prisma.pendingOrder.deleteMany({ where: { customerId: cust.id } });
      await prisma.customer.update({
        where: { id: cust.id },
        data: { humanRequestedAt: null }
      });
    }
  }

  async send(text: string): Promise<any[]> {
    this.adapter.clearLog();
    logger.info(`\n👨‍🦱 [USER]: ${text}`);
    
    const msg: InboundMessage = {
      phone: this.phone,
      text,
      name: "UAT Tester",
      mediaType: "text",
    };

    // Use ingest directly instead of routeCloudMessage because we overwrote the adapter
    await this.adapter.ingest(msg);
    
    // Wait for the asynchronous processing and DB writes to settle
    await new Promise((r) => setTimeout(r, 4000));
    
    const responses = [...this.adapter.outboundLog];
    for (const r of responses) {
      logger.info(`🤖 [BOT ]: [${r.type.toUpperCase()}] ${r.text || r.bodyText || r.caption}`);
    }
    
    return responses;
  }
}
