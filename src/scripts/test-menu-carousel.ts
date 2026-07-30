import { CloudAdapter } from "../whatsapp/cloud.js";
import { menuAsInteractiveCarouselCards } from "../services/menu.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const cloud = new CloudAdapter(
    process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    process.env.WHATSAPP_CLOUD_TOKEN || ""
  );

  try {
    const cards = await menuAsInteractiveCarouselCards(1);
    console.log(`Sending ${cards.length} cards...`);
    
    await cloud.sendInteractiveCarousel(
      "919398449524",
      "Here is the menu carousel",
      cards
    );
    console.log("Success");
  } catch (e: any) {
    console.error("Error sending carousel:", e.response?.data || e.message);
  }
}

main().catch(console.error);
