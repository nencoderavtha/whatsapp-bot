import 'dotenv/config';
import { prisma } from '../src/db.js';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';
import { DeliveryManager } from '../src/services/delivery/delivery-manager.js';

async function run() {
  console.log("=== STEP 1: CANCEL STUCK SHIPROCKET ORDER (1491077101) ===");
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
        body: JSON.stringify({ ids: [1491077101] }),
      });
      const cancelText = await cancelRes.text();
      console.log(`Shiprocket Cancel Response (${cancelRes.status}): ${cancelText}`);
    } catch (err) {
      console.error("Error calling Shiprocket cancel API:", err);
    }
  }

  console.log("\n=== STEP 2: CLEAR OLD DISPATCH ENTRY IN DB ===");
  await prisma.deliveryDispatch.deleteMany({
    where: { orderId: 9 },
  });
  await prisma.order.update({
    where: { id: 9 },
    data: { status: 'pending' },
  });
  console.log("Cleared old dispatch entry for Order #9.\n");

  console.log("=== STEP 3: DISPATCH ORDER #9 WITH FULL UN-TRUNCATED ADDRESS ===");
  const dispatchResult = await DeliveryManager.dispatchOrder(9);
  console.log("\n🚀 [Fresh Dispatch Result]:", JSON.stringify(dispatchResult, null, 2));

  if (dispatchResult.ok && dispatchResult.result?.dispatchId) {
    const rawId = Number(dispatchResult.result.dispatchId.replace(/^SR-/, ""));
    if (rawId) {
      console.log(`\n🔍 Verifying Status & Status Code for fresh Order ${rawId}...`);
      const res = await fetch(`https://apiv2.shiprocket.in/v1/external/orders/show/${rawId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      console.log("Order Verified Status:", {
        status: data.data?.status,
        status_code: data.data?.status_code,
        address_category: data.data?.extra_info?.address_category,
        address_risk: data.data?.extra_info?.address_risk,
      });
    }
  }
}

run().catch((err) => {
  console.error("❌ Error during order #9 re-dispatch:", err);
  process.exit(1);
});
