import 'dotenv/config';
import { prisma } from '../src/db.js';

async function listOrders() {
  const orders = await prisma.order.findMany({
    orderBy: { id: 'desc' },
    take: 10,
    include: { customer: true, deliveryDispatch: true },
  });

  console.log("=== DB ORDERS LIST ===");
  orders.forEach(o => {
    console.log(`Order #${o.id}: Status=${o.status}, Total=₹${o.total}, Customer=${o.customer.name} (${o.customer.phone}), DispatchId=${o.deliveryDispatch?.externalDeliveryId || 'NONE'}`);
  });
}

listOrders().catch(console.error);
