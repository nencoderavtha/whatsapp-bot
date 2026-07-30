import dotenv from "dotenv";
dotenv.config();

import { UberDirectDeliveryService } from "../src/services/delivery/uber-direct.js";

async function run() {
  const deliveryId = process.argv[2] || "del_2NEB4d2QSoyWYLKL0neVsQ";
  console.log(`🚫 Requesting cancellation for Uber Direct delivery: ${deliveryId}...`);

  const uber = new UberDirectDeliveryService();
  const res = await uber.cancelDelivery(deliveryId);

  console.log("\n📊 Cancellation Result:");
  console.log(JSON.stringify(res, null, 2));

  if (res.ok) {
    console.log(`\n✅ Uber Direct delivery ${deliveryId} has been successfully CANCELLED.`);
  } else {
    console.log(`\n❌ Failed to cancel delivery ${deliveryId}:`, res);
  }
}

run().catch(console.error);
