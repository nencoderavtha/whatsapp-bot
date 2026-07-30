import dotenv from "dotenv";
dotenv.config();

import { UberDirectDeliveryService } from "../src/services/delivery/uber-direct.js";

async function run() {
  const deliveryId = "del_AUX74yusST2AOxNovYmWaA";
  console.log(`🚫 Requesting cancellation for Uber Direct delivery: ${deliveryId}...`);

  // Use the credentials that booked the delivery (VCLNca-Ij09TRPlaLD54Dq0Gb7zhTYoU)
  const clientId = "VCLNca-Ij09TRPlaLD54Dq0Gb7zhTYoU";
  const clientSecret = "QW2a_hLl-L0FHZcwxNcawJknOnUL-DAzQd81m0UU";
  const customerId = "81c31018-3d19-5839-9c9d-20ced36d96b1";

  const params = new URLSearchParams();
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("grant_type", "client_credentials");
  params.append("scope", "eats.deliveries");

  const authRes = await fetch("https://auth.uber.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const authData = await authRes.json() as any;
  if (!authData.access_token) {
    console.error("❌ Auth failed:", authData);
    return;
  }

  const res = await fetch(`https://api.uber.com/v1/customers/${customerId}/deliveries/${deliveryId}/cancel`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${authData.access_token}`,
      "Content-Type": "application/json",
    },
  });

  const rawText = await res.text();
  console.log(`HTTP ${res.status}:`, rawText);

  if (res.ok) {
    console.log(`\n✅ Uber Direct delivery ${deliveryId} has been successfully CANCELLED.`);
  } else {
    console.log(`\n❌ Failed to cancel delivery ${deliveryId}`);
  }
}

run().catch(console.error);
