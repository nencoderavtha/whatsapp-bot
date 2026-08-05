import 'dotenv/config';
import { ShadowfaxDeliveryService } from '../src/services/delivery/shadowfax.js';
import { DeliveryOrchestrator } from '../src/services/delivery/orchestrator.js';

async function main() {
  console.log("==========================================================================");
  console.log("🚀 TESTING SHADOWFAX HYPERLOCAL FLASH DISPATCH");
  console.log("==========================================================================");

  const shadowfax = new ShadowfaxDeliveryService();
  console.log("Environment Config:");
  console.log("- Base URL:", (shadowfax as any).baseUrl);
  console.log("- API Key Configured:", Boolean((shadowfax as any).apiKey));
  console.log("- Client Code Configured:", (shadowfax as any).clientCode || "N/A");

  console.log("\n--- 1. Testing Serviceability / Quote ---");
  const quote = await shadowfax.getQuote({
    pickupPincode: 500033,
    deliveryPincode: 500081,
    pickupLat: 17.4319,
    pickupLng: 78.4072,
    deliveryLat: 17.4483,
    deliveryLng: 78.3808,
  });
  console.log("Quote Result:", JSON.stringify(quote, null, 2));

  console.log("\n--- 2. Testing Order Dispatch via DeliveryOrchestrator ---");
  const orchestrator = new DeliveryOrchestrator();
  const dispatchResult = await orchestrator.dispatchOrder({
    orderId: 999123,
    providerCode: "shadowfax",
    customerName: "Test Customer (Shadowfax)",
    customerPhone: "9876543210",
    deliveryAddress: "5/113, 9th Phase, Venkata Ramana Colony, Kukatpally, Hyderabad, Telangana 500085",
    pickupAddress: "Godavari Ruchulu, Road No. 45, Jubilee Hills, Hyderabad",
  });

  console.log("\nDispatch Result:", JSON.stringify(dispatchResult, null, 2));
  console.log("==========================================================================");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
