import 'dotenv/config';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';

async function printRaw() {
  const shiprocket = new ShiprocketDeliveryService();
  const token = await shiprocket.authenticate();

  if (!token) return;

  const res1 = await fetch(`https://apiv2.shiprocket.in/v1/external/orders/show/1491077101`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data1 = await res1.json();

  console.log("=== RAW SHIPROCKET SHOW RESPONSE (ORDER 1491077101) ===");
  console.log("Status      :", data1.data?.status);
  console.log("Status Code :", data1.data?.status_code);
  console.log("Extra Info  :", JSON.stringify(data1.data?.extra_info, null, 2));
  console.log("Errors Array:", JSON.stringify(data1.data?.errors, null, 2));
}

printRaw().catch(console.error);
