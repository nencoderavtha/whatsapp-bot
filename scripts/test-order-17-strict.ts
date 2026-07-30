import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../src/db.js";
import { DeliveryManager } from "../src/services/delivery/delivery-manager.js";

async function run() {
  console.log("=== STRICT PRODUCTION ORDER 17 DISPATCH ATTEMPT ===");
  console.log("Environment values read from .env:");
  console.log(`  UBER_ENV: ${process.env.UBER_ENV}`);
  console.log(`  UBER_CUSTOMER_ID: ${process.env.UBER_CUSTOMER_ID}`);
  console.log(`  UBER_CLIENT_ID: ${process.env.UBER_CLIENT_ID}`);

  // Step A: Reset any existing DB dispatch record for Order #17 so we can attempt a clean booking
  await prisma.deliveryDispatch.deleteMany({
    where: { orderId: 17 },
  });
  console.log("\n🔄 Cleared DB delivery dispatch row for Order #17.");

  console.log("\n🚀 Attempting to place Order #17 via DeliveryManager...");
  try {
    const result = await DeliveryManager.dispatchOrder(17, "uber");
    console.log("\n🎉 SUCCESS RESULT:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.log("\n❌ DISPATCH FAILED:");
    console.log("Error Message:", err?.message || String(err));
  }
}

run().catch(console.error).finally(() => prisma.$disconnect());
