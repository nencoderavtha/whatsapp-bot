import axios from "axios";

async function main() {
  const apiKey = "a005551cb3c12df49c7129703f2715a360b575b3891bd2041c0f0057da5e3237";
  const phoneNumberId = "597907523413541";
  const recipient = "919398449524";
  const testUrl = "https://example.com/deals";

  const endpoint = `https://api.kapso.ai/meta/whatsapp/v24.0/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: {
        text: "🌐 *Kapso In-App Browser Test*\n\nTap below to open the link directly in WhatsApp 👇"
      },
      action: {
        name: "cta_url",
        parameters: {
          display_text: "Visit website",
          url: testUrl
        }
      }
    }
  };

  console.log(`📤 Sending Kapso CTA message to ${recipient} via ${endpoint}...`);

  try {
    const res = await axios.post(endpoint, payload, {
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json"
      }
    });

    console.log("✅ Kapso Response Status:", res.status, res.statusText);
    console.log("📄 Kapso Response Data:", JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error("❌ Kapso Send Failed:", err?.response?.status, err?.response?.data ?? err?.message);
  }
}

main();
