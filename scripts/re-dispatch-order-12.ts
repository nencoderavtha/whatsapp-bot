import 'dotenv/config';
import { prisma } from '../src/db.js';
import { DeliveryManager } from '../src/services/delivery/delivery-manager.js';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';

async function run() {
  console.log("=== CHECKING ORDER #12 IN DB ===");
  let order = await prisma.order.findUnique({
    where: { id: 12 },
    include: { customer: true, deliveryDispatch: true },
  });

  if (!order) {
    console.log("Order #12 not found in DB. Creating Order #12...");
    let customer = await prisma.customer.findFirst({
      where: { phone: '919398449524' },
    });

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          name: 'Shivateja Customer',
          phone: '919398449524',
          address: '402, Bhavani Residency, Prashanth Hills Colony Rd, Prashant Hills, Gachibowli, Rai Durg, Hyderabad 500104',
          deliveryLat: 17.420299,
          deliveryLng: 78.382698,
        },
      });
    }

    order = await prisma.order.create({
      data: {
        id: 12,
        customerId: customer.id,
        status: 'pending',
        type: 'delivery',
        subtotal: 150,
        total: 150,
        deliveryAddress: '402, Bhavani Residency, Prashanth Hills Colony Rd, Prashant Hills, Gachibowli, Rai Durg, Hyderabad 500104',
        deliveryLat: 17.420299,
        deliveryLng: 78.382698,
      },
      include: { customer: true, deliveryDispatch: true },
    });
  }

  console.log("Order #12 Data:", JSON.stringify(order, null, 2));

  console.log("\n=== CLEARING PREVIOUS DISPATCH ENTRY FOR ORDER #12 ===");
  await prisma.deliveryDispatch.deleteMany({
    where: { orderId: 12 },
  });
  await prisma.order.update({
    where: { id: 12 },
    data: { status: 'pending' },
  });

  console.log("=== DISPATCHING ORDER #12 TO SHIPROCKET QUICK ===");
  const dispatchResult = await DeliveryManager.dispatchOrder(12);
  console.log("\n🚀 [Order #12 Dispatch Result]:", JSON.stringify(dispatchResult, null, 2));

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
      console.log("Order #12 Live API Status:", {
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
  console.error("❌ Error during Order #12 dispatch:", err);
  process.exit(1);
});
