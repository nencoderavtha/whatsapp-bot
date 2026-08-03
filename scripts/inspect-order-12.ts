import 'dotenv/config';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';

async function inspectOrder12() {
  const shiprocket = new ShiprocketDeliveryService();
  const token = await shiprocket.authenticate();

  if (!token) return;

  console.log("🔍 Fetching newest orders from /v1/external/orders...");
  const res = await fetch(`https://apiv2.shiprocket.in/v1/external/orders?sort_by=id&sort=desc&per_page=20`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  const orders = data.data || [];

  console.log("=== NEWEST ORDERS ===");
  orders.forEach((o: any) => {
    console.log(`Order #${o.id} | Channel: ${o.channel_order_id} | Status: ${o.status} (${o.status_code}) | Courier: ${o.courier_name || 'None'} | Address: ${o.customer_address}`);
  });
}

inspectOrder12().catch(console.error);
