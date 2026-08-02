/**
 * Delivery Quotes Tester Script
 * 
 * Pulls a sample delivery order or address from the database and requests
 * live quotes from both Borzo and Shiprocket Quick services to test connectivity.
 * 
 * Usage:
 *   npx tsx scripts/test-delivery-quotes.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../src/db.js";
import { BorzoDeliveryService } from "../src/services/delivery/borzo.js";
import { ShiprocketDeliveryService } from "../src/services/delivery/shiprocket.js";
import { ShadowfaxDeliveryService } from "../src/services/delivery/shadowfax.js";

// Helper function to extract pincode from address string
function pincodeFromAddress(address?: string | null): number | null {
  const m = address?.match(/(\d{6})\s*$/) ?? address?.match(/\b(\d{6})\b/);
  return m ? Number(m[1]) : null;
}

async function run() {
  console.log("🔍 Checking database for a sample delivery order...");
  
  const sampleOrder = await prisma.order.findFirst({
    where: { 
      type: "delivery",
      deliveryAddress: { not: null }
    },
    orderBy: { id: "desc" },
    include: { customer: true }
  });

  let pickupPincode = 500081; // Madhapur (fallback)
  let deliveryAddress = "Flat 402, My Home Bhooja, Silpa Gram Craft Village, Gachibowli, Hyderabad 500081";
  let deliveryPincode = 500081;
  let deliveryLat: number | undefined = undefined;
  let deliveryLng: number | undefined = undefined;
  let deliveryPhone = "919999999999";

  // Check if restaurant config has coordinates and address
  const restaurant = await prisma.restaurantConfig.findFirst({ where: { id: 1 } });
  if (restaurant && restaurant.restaurantAddress) {
    const parsedPickupPincode = pincodeFromAddress(restaurant.restaurantAddress);
    if (parsedPickupPincode) pickupPincode = parsedPickupPincode;
  }

  if (sampleOrder && sampleOrder.deliveryAddress) {
    console.log(`✨ Found Sample Order #${sampleOrder.id} in database!`);
    deliveryAddress = sampleOrder.deliveryAddress;
    deliveryPincode = pincodeFromAddress(deliveryAddress) ?? 500081;
    deliveryLat = sampleOrder.deliveryLat ?? undefined;
    deliveryLng = sampleOrder.deliveryLng ?? undefined;
    deliveryPhone = sampleOrder.customer.phone;
  } else {
    console.log("ℹ️ No sample delivery order found in DB. Using default test address.");
  }

  console.log("\n--------------------------------------------------");
  console.log("📍 [Pickup Point]");
  console.log(`   Address:   ${restaurant?.restaurantAddress || "Madhapur, Hyderabad"}`);
  console.log(`   Pincode:   ${pickupPincode}`);
  console.log(`   Phone:     ${restaurant?.ownerNumbers?.split(",")[0] || "None"}`);
  console.log("📍 [Delivery Destination]");
  console.log(`   Address:   "${deliveryAddress}"`);
  console.log(`   Pincode:   ${deliveryPincode}`);
  console.log(`   Phone:     ${deliveryPhone}`);
  console.log(`   Location:  Lat=${deliveryLat ?? "N/A"}, Lng=${deliveryLng ?? "N/A"}`);
  console.log("--------------------------------------------------\n");

  const results: Record<string, any> = {};

  // 1. Borzo Quote Query
  console.log("🚀 Requesting live quote from Borzo API (Production)...");
  const borzo = new BorzoDeliveryService("production");
  try {
    const quote = await borzo.getQuote({
      pickupPincode,
      deliveryPincode,
      weightKg: 0.5,
      pickupAddress: restaurant?.restaurantAddress || undefined,
      pickupLat: restaurant?.restaurantLat,
      pickupLng: restaurant?.restaurantLng,
      pickupPhone: restaurant?.ownerNumbers?.split(",")[0] || undefined,
      deliveryAddress,
      deliveryLat,
      deliveryLng,
      deliveryPhone,
    });
    results.borzo = quote;
    console.log("✅ Borzo Quote Succeeded!");
  } catch (err: any) {
    console.error("❌ Borzo Quote Failed:", err?.message ?? err);
    results.borzo = { error: err?.message ?? err };
  }

  console.log("\n--------------------------------------------------\n");

  // 2. Shiprocket Quote Query
  console.log("🚀 Requesting live quote from Shiprocket Quick API...");
  const shiprocket = new ShiprocketDeliveryService();
  try {
    const quote = await shiprocket.getQuote({
      pickupPincode,
      deliveryPincode,
      weightKg: 0.5,
    });
    results.shiprocket = quote;
    console.log("✅ Shiprocket Quote Succeeded!");
  } catch (err: any) {
    console.error("❌ Shiprocket Quote Failed:", err?.message ?? err);
    results.shiprocket = { error: err?.message ?? err };
  }

  console.log("\n--------------------------------------------------\n");

  // 3. Shadowfax Quote Query
  console.log("🚀 Requesting live quote from Shadowfax Hyperlocal API...");
  const shadowfax = new ShadowfaxDeliveryService();
  try {
    const quote = await shadowfax.getQuote({
      pickupPincode,
      deliveryPincode,
      weightKg: 0.5,
      pickupLat: restaurant?.restaurantLat ?? undefined,
      pickupLng: restaurant?.restaurantLng ?? undefined,
      deliveryLat,
      deliveryLng,
    });
    results.shadowfax = quote;
    console.log("✅ Shadowfax Quote Succeeded!");
  } catch (err: any) {
    console.error("❌ Shadowfax Quote Failed:", err?.message ?? err);
    results.shadowfax = { error: err?.message ?? err };
  }

  console.log("\n==================================================");
  console.log("📊 Delivery Quote Comparison Results:");
  console.log("==================================================");
  console.log(JSON.stringify(results, null, 2));
}

run()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
