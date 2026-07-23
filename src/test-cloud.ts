/**
 * Quick test: send a WhatsApp message via Meta Cloud API.
 *
 * Usage:
 *   npx tsx src/test-cloud.ts <recipient_phone>
 *
 * Example:
 *   npx tsx src/test-cloud.ts 919876543210
 *
 * The recipient must be added as a test number in Meta Developer Dashboard
 * → WhatsApp → API Setup → "To" field first.
 */
import "dotenv/config";

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_CLOUD_TOKEN;
const TO = process.argv[2]; // recipient phone (digits only, e.g. 919876543210)

if (!PHONE_NUMBER_ID || !TOKEN) {
  console.error("❌ Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_CLOUD_TOKEN in .env");
  process.exit(1);
}

if (!TO) {
  console.error("Usage: npx tsx src/test-cloud.ts <recipient_phone>");
  console.error("Example: npx tsx src/test-cloud.ts 919876543210");
  process.exit(1);
}

async function testSend() {
  console.log(`📤 Sending test message to +${TO} via Cloud API...`);
  console.log(`   Phone Number ID: ${PHONE_NUMBER_ID}`);

  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: TO,
      type: "text",
      text: { body: "🎉 Hello from Godavari Ruchulu Bot! Cloud API is working!" },
    }),
  });

  const data: any = await resp.json();

  if (resp.ok) {
    console.log(`✅ Message sent successfully!`);
    console.log(`   Message ID: ${data.messages?.[0]?.id}`);
  } else {
    console.error(`❌ Failed (HTTP ${resp.status}):`);
    console.error(JSON.stringify(data, null, 2));

    // Common error hints
    const code = data.error?.code;
    if (code === 190) {
      console.log("\n💡 Token expired or invalid. Generate a new one in Meta Developer Dashboard.");
    } else if (code === 131030) {
      console.log("\n💡 Recipient not in test numbers. Add them in Meta Dashboard → WhatsApp → API Setup → 'To' field.");
    } else if (code === 100) {
      console.log("\n💡 Check your Phone Number ID — it may be incorrect.");
    }
  }
}

testSend().catch(console.error);
