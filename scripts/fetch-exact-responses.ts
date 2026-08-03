import 'dotenv/config';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';

async function fetchExactResponses() {
  const shiprocket = new ShiprocketDeliveryService();
  const token = await shiprocket.authenticate();

  if (!token) return;

  // 1. Fetching order 1491077101 (Invalid/Truncated address order that got status_code: 1 / address_category: invalid)
  console.log("==========================================================================");
  console.log("1. EXACT SHIPROCKET API RESPONSE FOR TRUNCATED/INVALID ADDRESS (status_code: 1):");
  console.log("==========================================================================");

  try {
    const res1 = await fetch(`https://apiv2.shiprocket.in/v1/external/orders/show/1491077101`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data1 = await res1.json();
    console.log(JSON.stringify({
      id: data1.data?.id,
      channel_order_id: data1.data?.channel_order_id,
      status: data1.data?.status,
      status_code: data1.data?.status_code,
      billing_address: data1.data?.billing_address,
      extra_info: {
        address_category: data1.data?.extra_info?.address_category,
        address_risk: data1.data?.extra_info?.address_risk,
        address_score: data1.data?.extra_info?.address_score,
        order_risk: data1.data?.extra_info?.order_risk,
        rto_risk: data1.data?.extra_info?.rto_risk,
      }
    }, null, 2));
  } catch (err) {
    console.error("Error fetching order 1491077101:", err);
  }

  // 2. Fetching order 1491514397 (Valid un-truncated address order that got status_code: 95 / SEARCHING FOR RIDER)
  console.log("\n==========================================================================");
  console.log("2. EXACT SHIPROCKET API RESPONSE FOR VALID ADDRESS (status_code: 95 / SEARCHING FOR RIDER):");
  console.log("==========================================================================");

  try {
    const res2 = await fetch(`https://apiv2.shiprocket.in/v1/external/orders/show/1491514397`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data2 = await res2.json();
    console.log(JSON.stringify({
      id: data2.data?.id,
      channel_order_id: data2.data?.channel_order_id,
      status: data2.data?.status,
      status_code: data2.data?.status_code,
      billing_address: data2.data?.billing_address,
      extra_info: {
        address_category: data2.data?.extra_info?.address_category,
        address_risk: data2.data?.extra_info?.address_risk,
        address_score: data2.data?.extra_info?.address_score,
        order_risk: data2.data?.extra_info?.order_risk,
        rto_risk: data2.data?.extra_info?.rto_risk,
      }
    }, null, 2));
  } catch (err) {
    console.error("Error fetching order 1491514397:", err);
  }
}

fetchExactResponses().catch(console.error);
