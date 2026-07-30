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
  console.log("🏁 Starting Uber Direct test order script...");

  console.log(`🌍 UBER_ENV: ${process.env.UBER_ENV || "not set"}`);
  console.log(`🆔 UBER_CUSTOMER_ID: ${process.env.UBER_CUSTOMER_ID ? "PRESENT" : "MISSING"}`);
  console.log(`🔑 UBER_CLIENT_ID: ${process.env.UBER_CLIENT_ID ? "PRESENT" : "MISSING"}`);
  console.log(
    `🛡️ UBER_CLIENT_SECRET: ${process.env.UBER_CLIENT_SECRET ? "PRESENT" : "MISSING"}`
  );

  const uber = new UberDirectDeliveryService();

  const sampleRoute = {
    orderId: Math.floor(100000 + Math.random() * 900000),
    pickupPincode: 500034,
    deliveryPincode: 500081,
    weightKg: 0.5,
    pickupAddress: "Godavari Ruchulu, MLA Colony, Road No 12, Banjara Hills, Hyderabad, Telangana 500034",
    pickupLat: 17.4143,
    pickupLng: 78.4312,
    pickupPhone: "+919999999999",
    pickupName: "Godavari Ruchulu",
    customerName: "Teja Test",
    customerPhone: "+919398449524",
    deliveryAddress: "Flat 402, My Home Bhooja, Silpa Gram Craft Village, Gachibowli, Hyderabad, Telangana 500081",
    deliveryLat: 17.4483,
    deliveryLng: 78.3741,
    items: [{ name: "Special Biryani", qty: 1, price: 350 }],
    subTotal: 350,
  };

  console.log("\n🚀 Step 1: Requesting delivery quote from Uber Direct...");
  try {
    const quote = await uber.getQuote({
      pickupPincode: sampleRoute.pickupPincode,
      deliveryPincode: sampleRoute.deliveryPincode,
      weightKg: sampleRoute.weightKg,
      pickupAddress: sampleRoute.pickupAddress,
      pickupLat: sampleRoute.pickupLat,
      pickupLng: sampleRoute.pickupLng,
      pickupPhone: sampleRoute.pickupPhone,
      deliveryAddress: sampleRoute.deliveryAddress,
      deliveryLat: sampleRoute.deliveryLat,
      deliveryLng: sampleRoute.deliveryLng,
      deliveryPhone: sampleRoute.customerPhone,
    });

    console.log("\n📊 Quote Response:");
    console.log(JSON.stringify(quote, null, 2));

    if (quote.available) {
      console.log(`\n✅ Quote Available! Fee: ₹${quote.quotedFee} | ETA: ${quote.estimatedMinutes} mins`);
    } else {
      console.log("\n⚠️ Quote Warning:", quote.error || "unavailable");
    }
  } catch (err) {
    console.error("❌ Error fetching quote:", err);
  }

  console.log("\n🚀 Step 2: Placing test delivery order on Uber Direct...");
  try {
    const dispatchResult = await uber.dispatchOrder(sampleRoute);
    console.log("\n📦 Uber Direct Order Dispatch Result:");
    console.log(JSON.stringify(dispatchResult, null, 2));

    if (dispatchResult.ok) {
      console.log(`\n🎉 Test Delivery Order Successfully Placed on Uber Direct!`);
      console.log(`🆔 Dispatch ID: ${dispatchResult.dispatchId}`);
      if (dispatchResult.trackingUrl) {
        console.log(`🔗 Tracking URL: ${dispatchResult.trackingUrl}`);
      }
    } else {
      console.log(`\n❌ Dispatch Failed: ${dispatchResult.message}`);
    }
  } catch (err) {
    console.error("💥 Dispatch Exception:", err);
  }
}

run().catch(console.error);
