import 'dotenv/config';
import { prisma } from '../src/db.js';
import { DeliveryManager } from '../src/services/delivery/delivery-manager.js';

async function run() {
  const srcOrder = await prisma.order.findUnique({
    where: { id: 17 },
    include: { items: true }
  });

  if (!srcOrder) {
    throw new Error('Order 17 not found');
  }

  // Create new order in database with same customer, items, and delivery address
  const newOrder = await prisma.order.create({
    data: {
      customerId: srcOrder.customerId,
      status: 'ready',
      type: 'delivery',
      subtotal: srcOrder.subtotal,
      discountTotal: 0,
      deliveryFee: srcOrder.deliveryFee,
      total: srcOrder.total,
      deliveryAddress: srcOrder.deliveryAddress,
      deliveryLat: srcOrder.deliveryLat,
      deliveryLng: srcOrder.deliveryLng,
      items: {
        create: srcOrder.items.map((item) => ({
          menuItemId: item.menuItemId,
          nameSnap: item.nameSnap,
          priceSnap: item.priceSnap,
          qty: item.qty
        }))
      }
    }
  });

  console.log(`\n✨ [New Order Created] Order #${newOrder.id} successfully created in database.`);
  console.log(`🚀 [Dispatch Triggered] Sending Order #${newOrder.id} to Shiprocket Quick...`);

  const dispatchRes = await DeliveryManager.dispatchOrder(newOrder.id);
  console.log('\n📦 [Dispatch Result]:\n', JSON.stringify({ newOrderId: newOrder.id, dispatchRes }, null, 2));
}

run().catch((err) => {
  console.error('❌ Error during dispatch:', err);
  process.exit(1);
});
