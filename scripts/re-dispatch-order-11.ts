import 'dotenv/config';
import { prisma } from '../src/db.js';
import { DeliveryManager } from '../src/services/delivery/delivery-manager.js';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';

async function run() {
  console.log("=== CHECKING ORDER #11 IN DB ===");
  let order = await prisma.order.findUnique({
    where: { id: 11 },
    include: { customer: true, deliveryDispatch: true },
  });

  if (!order) {
    console.log("Order #11 not found in DB. Creating Order #11 for Sathvik Customer...");
    let customer = await prisma.customer.findFirst({
      where: { phone: '916305500512' },
    });

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          name: 'Sathvik Customer',
          phone: '916305500512',
          address: '406, Bhavani Residency, Prashanth Hills Colony, Rai Durg, Gachibowli, Hyderabad 500104',
          deliveryLat: 17.420544,
          deliveryLng: 78.382704,
        },
      });
    }

    order = await prisma.order.create({
      data: {
        id: 11,
        customerId: customer.id,
        status: 'pending',
        type: 'delivery',
        subtotal: 150,
        total: 150,
        deliveryAddress: '406, Bhavani Residency, Prashanth Hills Colony, Rai Durg, Gachibowli, Hyderabad 500104',
        deliveryLat: 17.420544,
        deliveryLng: 78.382704,
      },
      include: { customer: true, deliveryDispatch: true },
    });
  }

  console.log("Order #11 Data:", JSON.stringify(order, null, 2));

  console.log("\n=== CLEARING PREVIOUS DISPATCH ENTRY FOR ORDER #11 ===");
  await prisma.deliveryDispatch.deleteMany({
    where: { orderId: 11 },
  });
  await prisma.order.update({
    where: { id: 11 },
    data: { status: 'pending' },
  });

  console.log("=== DISPATCHING ORDER #11 TO SHIPROCKET QUICK ===");
  const dispatchResult = await DeliveryManager.dispatchOrder(11);
  console.log("\n🚀 [Order #11 Dispatch Result]:", JSON.stringify(dispatchResult, null, 2));

  if (dispatchResult.ok && dispatchResult.result?.dispatchId) {
    const rawId = Number(dispatchResult.result.dispatchId.replace(/^SR-/, ""));
    const shiprocket = new ShiprocketDeliveryService();
    const token = await shiprocket.authenticate();
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
