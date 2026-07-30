import { CloudAdapter } from "../whatsapp/cloud.js";
import { menuAsInteractiveCarouselCards } from "../services/menu.js";
import dotenv from "dotenv";

dotenv.config();

// Stub the adapter's methods to avoid actually sending to WhatsApp, or just test if cards.length > 0
async function sendMenuVisual(
  adapter: CloudAdapter,
  phone: string,
  restaurantId: number,
  bodyText: string,
  webMenuUrl?: string,
): Promise<void> {
  const cards = await menuAsInteractiveCarouselCards(restaurantId);
  console.log(`Cards length: ${cards.length}`);
  if (cards.length > 0) {
    try {
      await adapter.sendInteractiveCarousel(phone, bodyText, cards);
      console.log("Carousel sent successfully");
    } catch (e: any) {
      console.warn("[Interactive Carousel Failed]", e.response?.data || e.message || e);
    }
  } else {
    console.log("No cards to send!");
  }
}

async function main() {
  const cloud = new CloudAdapter(
    process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    process.env.WHATSAPP_CLOUD_TOKEN || ""
  );

  await sendMenuVisual(cloud, "919398449524", 1, "🔥 Ee Roju Specials & Menu:", "https://example.com/menu");
}

main().catch(console.error);
