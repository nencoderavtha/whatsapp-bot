import { CloudAdapter } from "../whatsapp/cloud.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const cloud = new CloudAdapter(
    process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    process.env.WHATSAPP_CLOUD_TOKEN || ""
  );

  try {
    await cloud.sendInteractiveCarousel(
      "919398449524",
      "Here is a test carousel",
      [
        {
          title: "Test Card",
          desc: "Description",
          imageUrl: "https://godavariruchulu.com/img/food1.jpg",
          buttonId: "test_btn",
          buttonTitle: "Add"
        }
      ]
    );
    console.log("Success");
  } catch (e: any) {
    console.error("Error sending carousel:", e.response?.data || e.message);
  }
}

main().catch(console.error);
