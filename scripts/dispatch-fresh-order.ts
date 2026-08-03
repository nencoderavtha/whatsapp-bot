import 'dotenv/config';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';

async function run() {
  const shiprocket = new ShiprocketDeliveryService();

  console.log("🚀 Placing fresh order on Shiprocket Quick from Venky's Idly (KPHB) to Bhavani Residency (Gachibowli)...");

  const result = await shiprocket.dispatchOrder({
    orderId: 999,
    customerName: "Sathvik Customer",
    customerPhone: "916305500512",
    deliveryAddress: "406, Bhavani Residency, Prashanth Hills Colony, Rai Durg, Gachibowli, Hyderabad 500104",
    deliveryLat: 17.420544,
    deliveryLng: 78.382704,
    pickupLat: 17.4929148369678,
    pickupLng: 78.39597322530967,
    items: [{ name: "Idly & Sambar Package", qty: 1, price: 120 }],
    subTotal: 120,
  });

  console.log("\n📦 [Dispatch Result]:", JSON.stringify(result, null, 2));

  if (result.ok && result.dispatchId) {
    const rawId = Number(result.dispatchId.replace(/^SR-/, ""));
    const token = await shiprocket.authenticate();
    if (token && rawId) {
      console.log(`\n🔍 Verifying Live API Status for Order ${rawId}...`);
      const res = await fetch(`https://apiv2.shiprocket.in/v1/external/orders/show/${rawId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      console.log("Order Live API Status:", {
        id: data.data?.id,
        channel_order_id: data.data?.channel_order_id,
        status: data.data?.status,
        status_code: data.data?.status_code,
        pickup_location: data.data?.pickup_address?.pickup_code,
        pickup_address: data.data?.pickup_address?.address,
        drop_address: data.data?.shipping_address || data.data?.billing_address,
      });
    }
  }
}

run().catch((err) => {
  console.error("❌ Error placing order on Shiprocket Quick:", err);
  process.exit(1);
});
