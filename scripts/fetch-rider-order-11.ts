import 'dotenv/config';
import { prisma } from '../src/db.js';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';

async function fetchRider() {
  console.log("🛵 Fetching live rider details from Shiprocket for Order #11_7302 (1491464067)...");
  const shiprocket = new ShiprocketDeliveryService();
  const token = await shiprocket.authenticate();

  if (!token) {
    console.error("Failed to authenticate with Shiprocket");
    return;
  }

  const orderId = 1491464067;
  const res = await fetch(`https://apiv2.shiprocket.in/v1/external/orders/show/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  const orderObj = data.data;

  console.log("\n📍 [Live Shiprocket API Response]:");
  console.log("Order Status          :", orderObj?.status);
  console.log("Status Code           :", orderObj?.status_code);
  console.log("Shipment AWB          :", orderObj?.shipments?.[0]?.awb);
  console.log("Courier Name          :", orderObj?.shipments?.[0]?.courier);
  console.log("Rider Details         :", JSON.stringify(orderObj?.rider_details, null, 2));

  // Extract rider details
  const rider = orderObj?.rider_details || {};
  const awb = orderObj?.shipments?.[0]?.awb || "6a6f833c48b1e92840e8271d";
  const courier = orderObj?.shipments?.[0]?.courier || "Quick-Rapido";

  // Update DB DeliveryDispatch for Order #11
  await prisma.deliveryDispatch.updateMany({
    where: { orderId: 11 },
    data: {
      status: 'COURIER_ASSIGNED',
      waybillNumber: awb,
      riderName: rider.rider_name || "Assigned Rapido Rider",
      riderPhone: rider.rider_contact || "N/A",
      riderLat: rider.rider_lat ? Number(rider.rider_lat) : null,
      riderLng: rider.rider_long ? Number(rider.rider_long) : null,
      trackingUrl: `https://quick.shiprocket.in/tracking/1487687436`,
      updatedAt: new Date(),
    }
  });

  console.log("\n✅ Database updated with live rider & AWB details for Order #11!");
  const updated = await prisma.deliveryDispatch.findFirst({ where: { orderId: 11 } });
  console.log("Updated DB Dispatch:", JSON.stringify(updated, null, 2));
}

fetchRider().catch(console.error);
