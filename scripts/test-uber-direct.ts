/**
 * Uber Direct Quote Tester Script
 *
 * Requests a live quote from Uber Direct to verify credentials, connectivity, and response formats.
 *
 * Usage:
 *   npx tsx scripts/test-uber-direct.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { UberDirectDeliveryService } from "../src/services/delivery/uber-direct.js";

async function run() {
  console.log("🏁 Starting Uber Direct quote verification script...");

  // Print env details (with secrets redacted)
  console.log(`🌍 UBER_ENV: ${process.env.UBER_ENV || "not set (defaulting to sandbox)"}`);
  console.log(`🆔 UBER_CUSTOMER_ID: ${process.env.UBER_CUSTOMER_ID ? "PRESENT" : "MISSING"}`);
  console.log(`🔑 UBER_CLIENT_ID: ${process.env.UBER_CLIENT_ID ? "PRESENT" : "MISSING"}`);
  console.log(
    `🛡️ UBER_CLIENT_SECRET: ${process.env.UBER_CLIENT_SECRET ? "PRESENT" : "MISSING"}`
  );

  const uber = new UberDirectDeliveryService();
  console.log("\n🚀 Requesting quote from Uber Direct...");

  try {
    const quote = await uber.getQuote({
      pickupPincode: 500081,
      deliveryPincode: 500081,
      weightKg: 0.5,
      // Sample Hyderabad route coordinates (Jubilee Hills to Madhapur)
      pickupAddress: "Godavari Ruchulu, MLA Colony, Road No 12, Banjara Hills, Hyderabad, Telangana 500034",
      pickupLat: 17.4143,
      pickupLng: 78.4312,
      pickupPhone: "919999999999",
      deliveryAddress: "Flat 402, My Home Bhooja, Silpa Gram Craft Village, Gachibowli, Hyderabad, Telangana 500081",
      deliveryLat: 17.4483,
      deliveryLng: 78.3741,
      deliveryPhone: "919398449524",
    });

    console.log("\n📊 Quote Response Result:");
    console.log(JSON.stringify(quote, null, 2));

    if (quote.available) {
      console.log("\n🎉 Quote Success!");
      console.log(`💰 Delivery Fee: ₹${quote.quotedFee}`);
      console.log(`⏱️ Transit Duration: ${quote.estimatedMinutes} mins`);
    } else {
      console.log("\n❌ Quote is unavailable:", quote.error || "unknown reason");
    }
  } catch (err) {
    console.error("\n💥 Executed with exception:", err);
  }
}

run().catch(console.error);
