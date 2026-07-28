import dotenv from "dotenv";
dotenv.config();

import { BorzoDeliveryService } from "../src/services/delivery/borzo.js";
import { ShiprocketDeliveryService } from "../src/services/delivery/shiprocket.js";

async function run() {
  const pickupPincode = 500072;
  const deliveryPincode = 500018;
  const pickupAddress = "Venky's idli";
  const deliveryAddress = "Bhavani Residency, Prashant Hills, Gachibowli, Khajaguda, Hyderabad, Telangana";
  const pickupLat = 17.4929097372023;
  const pickupLng = 78.3959303153406;
  const deliveryLat = 17.50124400201;
  const deliveryLng = 78.40487816386;
  const deliveryPhone = "919398449524";

  console.log("🚀 Debugging Borzo API request...");
  const borzo = new BorzoDeliveryService();
  
  // Temporarily inspect raw fetch response by monkey-patching or manual fetch replica
  try {
    const isSandbox = (process.env.BORZO_ENV ?? "sandbox") !== "production";
    const baseUrl = isSandbox ? "https://robotapitest-in.borzodelivery.com/api/business/1.8" : "https://robot-in.borzodelivery.com/api/business/1.8";
    
    console.log(`Using Base URL: ${baseUrl}`);
    
    const body = {
      matter: "Food parcel",
      total_weight_kg: 0.5,
      points: [
        {
          address: pickupAddress,
          contact_person: { phone: deliveryPhone },
          latitude: String(pickupLat),
          longitude: String(pickupLng),
        },
        {
          address: deliveryAddress,
          contact_person: { phone: deliveryPhone },
          latitude: String(deliveryLat),
          longitude: String(deliveryLng),
        }
      ]
    };
    
    console.log("Payload:", JSON.stringify(body, null, 2));

    const token = ((process.env.BORZO_ENV ?? "sandbox") === "production" ? process.env.BORZO_PROD_API_TOKEN : process.env.BORZO_API_TOKEN) || "";
    const res = await fetch(`${baseUrl}/calculate-order`, {
      method: "POST",
      headers: {
        "X-DV-Auth-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    console.log(`Status Code: ${res.status}`);
    const data = await res.json();
    console.log("Response Body:", JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.error("Borzo test error:", err);
  }

  console.log("\n--------------------------------------------------\n");

  console.log("🚀 Debugging Shiprocket API request...");
  const shiprocket = new ShiprocketDeliveryService();
  try {
    const token = await (shiprocket as any).authenticate();
    console.log(`Auth Token Token: ${token ? "Retrieved Successfully" : "Failed"}`);
    
    if (token) {
      const queryParams: Record<string, string> = {
        pickup_postcode: pickupPincode.toString(),
        delivery_postcode: deliveryPincode.toString(),
        weight: "0.5",
        cod: "0",
        is_new_hyperlocal: "1",
        lat_from: pickupLat.toString(),
        long_from: pickupLng.toString(),
        lat_to: deliveryLat.toString(),
        long_to: deliveryLng.toString(),
      };
      
      const query = new URLSearchParams(queryParams);
      console.log(`Query Params: ${query.toString()}`);
      
      const res = await fetch(`https://apiv2.shiprocket.in/v1/external/courier/serviceability?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      console.log(`Status Code: ${res.status}`);
      const data = await res.json();
      console.log("Response Body:", JSON.stringify(data, null, 2));
    }
  } catch (err: any) {
    console.error("Shiprocket test error:", err);
  }
}

run();
