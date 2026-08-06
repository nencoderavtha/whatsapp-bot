import { CloudAdapter } from "../src/whatsapp/cloud.js";
import { config } from "../src/config.js";
import { logger } from "../src/services/logger.js";

async function main() {
  const targetPhone = process.argv[2];
  if (!targetPhone) {
    console.log("Usage: npx tsx scripts/send-cta-test.ts <phone_number> [url]");
    process.exit(1);
  }

  // Ensure country code (e.g., 91 for India if 10 digits)
  let cleanPhone = targetPhone.replace(/\D/g, "");
  if (cleanPhone.length === 10) {
    cleanPhone = `91${cleanPhone}`;
  }

  const url = process.argv[3] ?? config.serverUrl ?? "https://robe-sagging-envoy.ngrok-free.dev";
  const adapter = new CloudAdapter(config.cloud.phoneNumberId, config.cloud.token);

  logger.info(`📤 Sending CTA URL test button to ${cleanPhone} pointing to: ${url}`);

  try {
    await adapter.sendInteractiveCtaUrl(
      cleanPhone,
      "🌐 *WhatsApp In-App Browser Test*\n\nTap the button below to open the link directly in WhatsApp 👇",
      "🌐 Open Web Page",
      url,
    );
    logger.info("✅ Test CTA URL message sent successfully!");
  } catch (err: any) {
    logger.error("❌ Failed to send CTA URL test message:", err?.response?.data ?? err?.message ?? err);
  }
}

main();
