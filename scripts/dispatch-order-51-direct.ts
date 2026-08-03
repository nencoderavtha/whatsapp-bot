import 'dotenv/config';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';

async function run() {
  const shiprocket = new ShiprocketDeliveryService();

  console.log("=== STEP 1: CANCEL PREVIOUS TEST ORDERS ON SHIPROCKET ===");
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

  console.log("\n=== STEP 2: DISPATCH FRESH HYPERLOCAL ORDER #51 ===");
  console.log("Dispatching Order #51 from Venky's Idly (KPHB) to Prashanth Hills Colony...");

  const result = await shiprocket.dispatchOrder({
    orderId: 51,
    customerName: "exter-ai Customer",
    customerPhone: "7200141512",
    deliveryAddress: "402, Bhavani Residency, Prashanth Hills Colony, Rai Durg, Gachibowli, Hyderabad 500104",
    deliveryLat: 17.420299,
    deliveryLng: 78.382698,
    pickupLat: 17.4929148369678,
    pickupLng: 78.39597322530967,
    items: [{ name: "Parota", qty: 1, price: 100 }],
    subTotal: 100,
  });

  console.log("\n🚀 [Order #51 Dispatch Result]:", JSON.stringify(result, null, 2));

  if (result.ok && result.dispatchId) {
    const rawId = Number(result.dispatchId.replace(/^SR-/, ""));
    if (token && rawId) {
      console.log(`\n🔍 Verifying Live API Status for Order ${rawId}...`);
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
        address: data.data?.pickup_address?.address,
      });
    }
  }
}

run().catch((err) => {
  console.error("❌ Error during Order #51 dispatch:", err);
  process.exit(1);
});
