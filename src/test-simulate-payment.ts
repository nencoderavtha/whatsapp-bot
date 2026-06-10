/**
 * Simulates a Razorpay payment_link.paid webhook for the test customer.
 * Use when you can't pay in test mode — mimics the exact webhook payload.
 * Run: npx tsx src/test-simulate-payment.ts
 */
import { prisma } from "./db.js";
import { createOrder } from "./services/order.js";
import { orderConfirmationMsg, ownerNewOrderMsg } from "./services/notifications.js";

const TEST_PHONE    = "919000000001";
const RESTAURANT_ID = 1;

async function main() {
  console.log("🔍 Looking up test customer...");
  const customer = await prisma.customer.findFirst({
    where: { phone: TEST_PHONE, restaurantId: RESTAURANT_ID },
  });
  if (!customer) {
    console.error("❌ No test customer found. Run test-order-flow.ts first to place an order.");
    process.exit(1);
  }

  const pending = await prisma.pendingOrder.findUnique({ where: { customerId: customer.id } });
  if (!pending) {
    console.error("❌ No pending order found for test customer.");
    process.exit(1);
  }
  if (pending.confirmedOrderId) {
    console.log(`⚠️  Order already confirmed — Order #${pending.confirmedOrderId}`);
    process.exit(0);
  }

  const cart = {
    lines: JSON.parse(pending.lines),
    type: pending.type,
    note: pending.note ?? undefined,
  };

  console.log(`✅ Found pending order: ${cart.lines.length} item(s), type=${cart.type}`);
  console.log("💳 Simulating Razorpay payment_link.paid webhook...\n");

  // Create the order exactly as the webhook handler would
  const order = await createOrder({
    customerId: customer.id,
    restaurantId: RESTAURANT_ID,
    type: cart.type,
    note: cart.note,
    lines: cart.lines,
    payment: {
      method:    "upi",
      reference: "sim_pay_" + Date.now(),
      status:    "paid",
      paidAt:    new Date(),
    },
  });

  // Stamp pending order as confirmed
  await prisma.pendingOrder.update({
    where: { customerId: customer.id },
    data: { confirmedOrderId: order.id },
  });

  const cfg = await prisma.botConfig.findUnique({ where: { id: RESTAURANT_ID } });
  const restaurantName = cfg?.restaurantName ?? "Restaurant";
  const fullOrder = { ...order, customer };

  console.log("=".repeat(60));
  console.log(`  ✅ ORDER #${order.id} CONFIRMED`);
  console.log(`  💰 Total: ₹${order.total}`);
  console.log(`  📦 Type: ${order.type}`);
  console.log(`  💳 Payment: UPI (simulated)`);
  console.log("=".repeat(60));

  console.log("\n📨 WhatsApp message that would be sent to customer:\n");
  console.log(orderConfirmationMsg(fullOrder, restaurantName));

  const ownerNumbers = (cfg?.ownerNumbers ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (ownerNumbers.length > 0) {
    console.log("\n📨 WhatsApp message that would be sent to owner(s):\n");
    console.log(ownerNewOrderMsg(fullOrder));
  } else {
    console.log("\n⚠️  No owner numbers configured — owner notification skipped.");
  }

  console.log("\n👉 Check the admin dashboard Orders tab — Order #" + order.id + " should appear now.");

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
