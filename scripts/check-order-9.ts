import 'dotenv/config';
import { prisma } from '../src/db.js';

async function run() {
  console.log("Checking DB for Order #9...");
  const order = await prisma.order.findFirst({
    where: { id: 9 },
    include: { dispatches: true, customer: true },
  });
  console.log("Order #9:", JSON.stringify(order, null, 2));

  const allDispatches = await prisma.deliveryDispatch.findMany({
    take: 10,
    orderBy: { createdAt: 'desc' },
  });
  console.log("Recent Dispatches:", JSON.stringify(allDispatches, null, 2));
}

run().catch((err) => {
  console.error("Error checking Order #9:", err);
});
