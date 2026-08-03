import 'dotenv/config';
import { prisma } from '../src/db.js';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';
import { DeliveryManager } from '../src/services/delivery/delivery-manager.js';

async function run() {
  console.log("=== STEP 1: CANCEL TEST ORDERS ON SHIPROCKET ===");
  const shiprocket = new ShiprocketDeliveryService();
  const token = await shiprocket.authenticate();

  const testOrderIds = [1491087101, 1491088397]; // Test Order #99 and Order #9

  if (token) {
    try {
      console.log(`Cancelling test orders ${testOrderIds.join(", ")} on Shiprocket...`);
      const cancelRes = await fetch("https://apiv2.shiprocket.in/v1/external/orders/cancel", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: testOrderIds }),
      });
      const cancelText = await cancelRes.text();
      console.log(`Shiprocket Cancel Response (${cancelRes.status}): ${cancelText}`);
    } catch (err) {
      console.error("Error calling Shiprocket cancel API:", err);
    }
  }

  console.log("\n=== STEP 2: CLEAR OLD DISPATCH ENTRY FOR ORDER #51 IN DB ===");
  await prisma.deliveryDispatch.deleteMany({
    where: { orderId: 51 },
  });
  await prisma.order.update({
    where: { id: 51 },
    data: { status: 'pending' },
  });
  console.log("Cleared old dispatch entry for Order #51 in DB.\n");

  console.log("=== STEP 3: RE-DISPATCH ORDER #51 TO SHIPROCKET QUICK ===");
  const dispatchResult = await DeliveryManager.dispatchOrder(51);
  console.log("\n🚀 [Order #51 Dispatch Result]:", JSON.stringify(dispatchResult, null, 2));

  console.log("\n=== STEP 4: VERIFY ORDER #51 DISPATCH & API STATUS ===");
  const newDispatch = await prisma.deliveryDispatch.findFirst({
    where: { orderId: 51 },
  });
  console.log("New DeliveryDispatch in DB:", JSON.stringify(newDispatch, null, 2));

  if (dispatchResult.ok && dispatchResult.result?.dispatchId) {
    const rawId = Number(dispatchResult.result.dispatchId.replace(/^SR-/, ""));
    if (token && rawId) {
      console.log(`\n🔍 Checking API Status for Order ${rawId}...`);
      const res = await fetch(`https://apiv2.shiprocket.in/v1/external/orders/show/${rawId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      console.log("Order #51 Live API Status:", {
        id: data.data?.id,
        channel_order_id: data.data?.channel_order_id,
        status: data.data?.status,
        status_code: data.data?.status_code,
        pickup_location: data.data?.pickup_address?.pickup_code,
      });
    }
  }
}

run().catch((err) => {
  console.error("❌ Error during order #51 re-dispatch:", err);
  process.exit(1);
});
