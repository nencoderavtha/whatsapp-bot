import 'dotenv/config';
import { prisma } from '../src/db.js';
import { DeliveryOrchestrator } from '../src/services/delivery/orchestrator.js';

async function run() {
  console.log("==========================================================================");
  console.log("📦 DISPATCHING LATEST ORDER TO SHADOWFAX HYPERLOCAL");
  console.log("==========================================================================");

  const latestOrder = await prisma.order.findFirst({
    orderBy: { id: 'desc' },
    include: { customer: true, items: true, deliveryDispatch: true },
  });

  if (!latestOrder) {
    console.error("❌ No orders found in DB.");
    return;
  }

  const restaurant = await prisma.restaurantConfig.findFirst();

  const pickupAddress = restaurant?.restaurantAddress || "5, Kukatpally Housing Board Rd, Kukatpally Housing Board Colony, K P H B Phase 1, Kukatpally, Hyderabad, Telangana 500072";
  const dropAddress = latestOrder.deliveryAddress || "402, Bhavani Residency, Prashant Hills, Gachibowli, Hyderabad, Telangana 500104";

  console.log("📍 Order Details:");
  console.log(`- Order ID: #${latestOrder.id}`);
  console.log(`- Customer Name: ${latestOrder.customer.name}`);
  console.log(`- Customer Phone: ${latestOrder.customer.phone}`);
  console.log(`- Pickup Address: ${pickupAddress}`);
  console.log(`- Drop Address: ${dropAddress}`);

  console.log("\n🚀 Triggering Shadowfax Dispatch API...");
  const orchestrator = new DeliveryOrchestrator();

  const result = await orchestrator.dispatchOrder({
    orderId: latestOrder.id,
    providerCode: "shadowfax",
    customerName: latestOrder.customer.name || "Customer",
    customerPhone: latestOrder.customer.phone,
    deliveryAddress: dropAddress,
    pickupAddress: pickupAddress,
  });

  console.log("\n📋 Dispatch Result:");
  console.log(JSON.stringify(result, null, 2));

  console.log("==========================================================================");
}

run().catch((err) => {
  console.error("❌ Error executing dispatch:", err);
  process.exit(1);
});
