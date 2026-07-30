import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../src/db.js";
import { DEFAULT_RESTAURANT_ID } from "../src/tenancy.js";
import { DeliveryManager } from "../src/services/delivery/delivery-manager.js";

async function run() {
  console.log("🔍 Inspecting Order #17 and Restaurant Config...");

  const order = await prisma.order.findUnique({
    where: { id: 17 },
    include: { customer: true, deliveryDispatch: true, items: true },
  });

  if (!order) {
    console.error("❌ Order #17 not found in database!");
    return;
  }

  console.log(`📦 Order #17 Details:`);
  console.log(`   Customer: ${order.customer.name} (${order.customer.phone})`);
  console.log(`   Delivery Address: ${order.deliveryAddress}`);
  console.log(`   Delivery Lat/Lng: ${order.deliveryLat}, ${order.deliveryLng}`);
  console.log(`   Current Status: ${order.status}`);
  console.log(`   Existing Dispatch:`, order.deliveryDispatch);

  // Update Restaurant Config pickup lat/lng as requested by user
  const newLat = 17.42017429804609;
  const newLng = 78.38572609187248;

  const restaurant = await prisma.restaurantConfig.update({
    where: { id: DEFAULT_RESTAURANT_ID },
    data: {
      restaurantLat: newLat,
      restaurantLng: newLng,
    },
  });

  console.log(`\n🏡 Updated Restaurant Config Pickup Coordinates:`);
  console.log(`   Name: ${restaurant.restaurantName}`);
  console.log(`   Address: ${restaurant.restaurantAddress}`);
  console.log(`   Owner Numbers: ${restaurant.ownerNumbers}`);
  console.log(`   Lat/Lng: ${restaurant.restaurantLat}, ${restaurant.restaurantLng}`);

  // Reset any existing dispatch if it was already marked NOT_DISPATCHED_YET or FAILED
  if (order.deliveryDispatch) {
    await prisma.deliveryDispatch.delete({
      where: { orderId: 17 },
    });
    console.log("🔄 Reset existing delivery dispatch record for Order #17");
  }

  console.log("\n🚀 Triggering Uber Direct dispatch for Order #17...");
  const result = await DeliveryManager.dispatchOrder(17, "uber");

  console.log("\n🎉 Dispatch Result:");
  console.log(JSON.stringify(result, null, 2));
}

run().catch(console.error).finally(() => prisma.$disconnect());
