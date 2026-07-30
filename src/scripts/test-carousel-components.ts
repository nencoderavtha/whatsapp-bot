import { CloudAdapter } from "../whatsapp/cloud.js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

async function main() {
  const token = process.env.WHATSAPP_CLOUD_TOKEN || "";
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
  const phone = "919398449524";

  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "interactive",
    interactive: {
      type: "carousel",
      body: { text: "Here is a test carousel" },
      action: {
        cards: [
          {
            card_index: 0,
            components: [
              {
                type: "header",
                parameters: [
                  {
                    type: "image",
                    image: { link: "https://godavariruchulu.com/img/food1.jpg" }
                  }
                ]
              },
              {
                type: "body",
                parameters: [
                  {
                    type: "text",
                    text: "Test Card 1"
                  }
                ]
              },
              {
                type: "button",
                sub_type: "quick_reply",
                index: "0",
                parameters: [
                  {
                    type: "payload",
                    payload: "test_btn_1"
                  }
                ]
              }
            ]
          },
          {
            card_index: 1,
            components: [
              {
                type: "header",
                parameters: [
                  {
                    type: "image",
                    image: { link: "https://godavariruchulu.com/img/food1.jpg" }
                  }
                ]
              },
              {
                type: "body",
                parameters: [
                  {
                    type: "text",
                    text: "Test Card 2"
                  }
                ]
              },
              {
                type: "button",
                sub_type: "quick_reply",
                index: "0",
                parameters: [
                  {
                    type: "payload",
                    payload: "test_btn_2"
                  }
                ]
              }
            ]
          }
        ]
      }
    }
  };

  try {
    const res = await axios.post(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("Success", res.data);
  } catch (e: any) {
    console.error("Error:", JSON.stringify(e.response?.data || e.message, null, 2));
  }
}

main().catch(console.error);
