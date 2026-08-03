import 'dotenv/config';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';

async function compareOrders() {
  const shiprocket = new ShiprocketDeliveryService();
  const token = await shiprocket.authenticate();

  if (!token) return;

  console.log("🔍 === FETCHING ALL RECENT ORDERS ===");
  const res = await fetch(`https://apiv2.shiprocket.in/v1/external/orders?per_page=15`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  const orders = data.data || [];

  orders.forEach((o: any) => {
    console.log(`Order #${o.id} | Channel: ${o.channel_order_id} | Status: ${o.status} (${o.status_code}) | Courier: ${o.courier_name || 'None'} | Address: ${o.customer_address}`);
  });
}

compareOrders().catch(console.error);
