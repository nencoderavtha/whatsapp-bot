import 'dotenv/config';
import { prisma } from '../src/db.js';
import { DeliveryManager } from '../src/services/delivery/delivery-manager.js';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';

async function run() {
  console.log("=== STEP 1: CANCEL OLD SHIPROCKET ORDER (1491464067) ===");
  const shiprocket = new ShiprocketDeliveryService();
  const token = await shiprocket.authenticate();

  if (token) {
    try {
      const cancelRes = await fetch("https://apiv2.shiprocket.in/v1/external/orders/cancel", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: [1491464067] }),
      });
      const cancelText = await cancelRes.text();
      console.log(`Shiprocket Cancel Response (${cancelRes.status}): ${cancelText}`);
    } catch (err) {
      console.error("Error calling Shiprocket cancel API:", err);
    }
  }

  console.log("\n=== STEP 2: CLEAR OLD DISPATCH ENTRY FOR ORDER #11 IN DB ===");
  await prisma.deliveryDispatch.deleteMany({
    where: { orderId: 11 },
  });
  await prisma.order.update({
    where: { id: 11 },
    data: { status: 'pending' },
  });
  console.log("Cleared old dispatch entry for Order #11 in DB.\n");

  console.log("=== STEP 3: DISPATCH FRESH ORDER #11 TO SHIPROCKET QUICK ===");
  const dispatchResult = await DeliveryManager.dispatchOrder(11);
  console.log("\n🚀 [Order #11 Dispatch Result]:", JSON.stringify(dispatchResult, null, 2));

  if (dispatchResult.ok && dispatchResult.result?.dispatchId) {
    const rawId = Number(dispatchResult.result.dispatchId.replace(/^SR-/, ""));
    if (token && rawId) {
      console.log(`\n🔍 Verifying Live API Status for Order ${rawId}...`);
      const res = await fetch(`https://apiv2.shiprocket.in/v1/external/orders/show/${rawId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      console.log("Order #11 Live API Status:", {
        id: data.data?.id,
        channel_order_id: data.data?.channel_order_id,
        status: data.data?.status,
        status_code: data.data?.status_code,
        pickup_location: data.data?.pickup_address?.pickup_code,
        pickup_address: data.data?.pickup_address?.address,
      });
    }
  }
}

run().catch((err) => {
  console.error("❌ Error during Order #11 dispatch:", err);
  process.exit(1);
});
