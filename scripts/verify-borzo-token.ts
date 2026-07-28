/**
 * Borzo API Token & Integration Verifier Script
 * 
 * Verifies your BORZO_API_TOKEN against Borzo's official v1.2 API
 * and tests incoming callback handler setup.
 * 
 * Usage:
 *   npx tsx scripts/verify-borzo-token.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { BorzoDeliveryService } from "../src/services/delivery/borzo.js";

async function verifyBorzoIntegration() {
  console.log("🔍 Checking Borzo Integration Configuration...\n");

  const env = process.env.BORZO_ENV || "sandbox";
  const isProd = env === "production";
  const apiToken = isProd ? process.env.BORZO_PROD_API_TOKEN : process.env.BORZO_API_TOKEN;
  const callbackToken = process.env.BORZO_CALLBACK_TOKEN;

  console.log(`🌐 BORZO_ENV: ${env.toUpperCase()}`);
  console.log(`🔑 Active Token (BORZO_${isProd ? "PROD_" : ""}API_TOKEN): ${apiToken ? `PRESENT (${apiToken.slice(0, 6)}...${apiToken.slice(-4)})` : "❌ NOT SET in .env"}`);
  console.log(`🛡️ BORZO_CALLBACK_TOKEN: ${callbackToken ? `PRESENT (${callbackToken.slice(0, 4)}...)` : "⚠️ Optional / NOT SET in .env"}`);
  console.log("--------------------------------------------------\n");

  if (!apiToken) {
    console.log(`⚠️ BORZO_${isProd ? "PROD_" : ""}API_TOKEN is missing from .env!`);
    console.log("Please open .env and add:");
    console.log(`  BORZO_${isProd ? "PROD_" : ""}API_TOKEN="your-borzo-token"`);
    console.log('  BORZO_CALLBACK_TOKEN="your-borzo-callback-token"');
    return;
  }

  console.log("🚀 Testing live rate calculation API call to Borzo (robot.borzodelivery.com)...");
  const borzoService = new BorzoDeliveryService();

  try {
    const quote = await borzoService.getQuote({
      pickupPincode: 500033,
      deliveryPincode: 500081,
      weightKg: 0.5,
    });

    console.log("\n✅ Borzo API Call Succeeded!");
    console.log("Response Data:");
    console.log(JSON.stringify(quote, null, 2));

    if (quote.quotedFee) {
      console.log(`\n🎉 Verification Passed! Quoted Fee: ₹${quote.quotedFee} (${quote.estimatedMinutes} mins)`);
    }
  } catch (err) {
    console.error("\n❌ Borzo API Call Failed:", err);
  }
}

verifyBorzoIntegration().catch((err) => {
  console.error("Fatal verification error:", err);
  process.exit(1);
});
