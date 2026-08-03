import 'dotenv/config';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';

async function testCleanDispatch() {
  const shiprocket = new ShiprocketDeliveryService();

  console.log("🚀 Testing Dispatch with Cleaned Address Formatting...");
  const result = await shiprocket.dispatchOrder({
    orderId: 99,
    customerName: "Sathvik Customer",
    customerPhone: "916305500512",
    deliveryAddress: "406, Bhavani Residency, Prashanth Hills Colony, Rai Durg, Gachibowli, Hyderabad 500104",
    deliveryLat: 17.420544,
    deliveryLng: 78.382704,
    pickupLat: 17.4929148369678,
    pickupLng: 78.39597322530967,
    items: [{ name: "Parotta", qty: 1, price: 100 }],
    subTotal: 100,
  });

  console.log("\n📦 [Dispatch Result]:", JSON.stringify(result, null, 2));

  if (result.ok && result.dispatchId) {
    const rawId = Number(result.dispatchId.replace(/^SR-/, ""));
    const token = await shiprocket.authenticate();
    if (token && rawId) {
      console.log(`\n🔍 Checking API Risk & Category Status for Order ${rawId}...`);
      const res = await fetch(`https://apiv2.shiprocket.in/v1/external/orders/show/${rawId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      console.log("Address Score & Category:", {
        address_category: data.data?.extra_info?.address_category,
        address_risk: data.data?.extra_info?.address_risk,
        address_score: data.data?.extra_info?.address_score,
        order_risk: data.data?.extra_info?.order_risk,
        status: data.data?.status,
        status_code: data.data?.status_code,
      });
    }
  }
}

testCleanDispatch();
