import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../src/db.js";
import { UberDirectDeliveryService } from "../src/services/delivery/uber-direct.js";
import { DeliveryManager } from "../src/services/delivery/delivery-manager.js";

async function run() {
  console.log("🏁 Step 1: Cancelling previous test order (del_NDE09mNeTkCfLeOLZcJeiw)...");
  
  // Create an instance using the test credentials token to cancel previous order on Sandbox
  const testClientId = "VCLNca-Ij09TRPlaLD54Dq0Gb7zhTYoU";
  const testClientSecret = "QW2a_hLl-L0FHZcwxNcawJknOnUL-DAzQd81m0UU";
  const testCustomerId = "81c31018-3d19-5839-9c9d-20ced36d96b1";

  try {
    const params = new URLSearchParams();
    params.append("client_id", testClientId);
    params.append("client_secret", testClientSecret);
    params.append("grant_type", "client_credentials");
    params.append("scope", "eats.deliveries");

    const authRes = await fetch("https://auth.uber.com/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const authData = await authRes.json() as any;
    if (authData.access_token) {
      const cancelRes = await fetch(`https://sandbox-api.uber.com/v1/customers/${testCustomerId}/deliveries/del_NDE09mNeTkCfLeOLZcJeiw/cancel`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${authData.access_token}`,
          "Content-Type": "application/json",
        },
      });
      console.log("   Previous Order Cancel HTTP Status:", cancelRes.status);
    }
  } catch (err) {
    console.warn("   Previous order cancellation warning:", err);
  }

  console.log("\n🔄 Step 2: Resetting database dispatch record for Order #17...");
  await prisma.deliveryDispatch.deleteMany({
    where: { orderId: 17 },
  });

  console.log("\n🚀 Step 3: Triggering Uber Direct dispatch with current .env credentials...");
  console.log(`   UBER_ENV: ${process.env.UBER_ENV}`);
  console.log(`   UBER_CUSTOMER_ID: ${process.env.UBER_CUSTOMER_ID}`);
  console.log(`   UBER_CLIENT_ID: ${process.env.UBER_CLIENT_ID}`);

  try {
    const result = await DeliveryManager.dispatchOrder(17, "uber");
    console.log("\n🎉 Production Order Dispatch Result:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("\n❌ Production Order Dispatch Failed:", err);
  }
}

run().catch(console.error).finally(() => prisma.$disconnect());
