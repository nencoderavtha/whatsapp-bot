import axios from "axios";

async function main() {
  const apiKey = "a005551cb3c12df49c7129703f2715a360b575b3891bd2041c0f0057da5e3237";
  const phoneNumberId = "597907523413541";
  const recipient = "919398449524";

  const endpoint = `https://api.kapso.ai/meta/whatsapp/v24.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: "⚡ *Kapso Interactive Button Test*\n\nTap the button below 👇"
      },
      action: {
        buttons: [
          {
            type: "reply",
            reply: {
              id: "btn_test_1",
              title: "📋 View Menu"
            }
          }
        ]
      }
    }
  };

  console.log(`📤 Sending Kapso interactive button to ${recipient}...`);

  try {
    const res = await axios.post(endpoint, payload, {
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json"
      }
    });

    console.log("✅ Kapso Button Response Status:", res.status, res.statusText);
    console.log("📄 Kapso Response Data:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("❌ Kapso Button Send Failed:", err?.response?.status, err?.response?.data ?? err?.message);
  }
}

main();
