require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  console.log("Checking DB for Order #9...");
  const order = await prisma.order.findFirst({
    where: { id: 9 },
    include: { deliveryDispatch: true, customer: true },
  });
  console.log("Order #9 in DB:", JSON.stringify(order, null, 2));

  const latestOrders = await prisma.order.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    include: { deliveryDispatch: true },
  });
  console.log("\nLatest Orders in DB:");
  latestOrders.forEach(o => {
    console.log(`Order #${o.id}: Status=${o.status}, Amount=${o.totalAmount}, DispatchId=${o.deliveryDispatch ? o.deliveryDispatch.dispatchId : 'NONE'}`);
  });
}

run().catch((err) => {
  console.error("Error checking Order #9:", err);
});
