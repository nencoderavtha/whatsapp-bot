/**
 * End-to-end order flow test — simulates a customer ordering via WhatsApp.
 * Run: npx tsx src/test-order-flow.ts
 */
import { handleIncoming } from "./ai/agent.js";
import { prisma } from "./db.js";

const PHONE = "919000000001";
const RESTAURANT_ID = 1;

async function say(text: string): Promise<string> {
  console.log(`\n👤 Customer: ${text}`);
  const { reply, placedOrderId } = await handleIncoming(PHONE, text, RESTAURANT_ID);
  const bubbles = reply.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  for (const b of bubbles) console.log(`🤖 Bot: ${b}`);
  if (placedOrderId) console.log(`\n   ✅ Order #${placedOrderId} placed`);
  return reply;
}

async function main() {
  console.log("=".repeat(60));
  console.log("  E2E Payment Flow Test — Restaurant #" + RESTAURANT_ID);
  console.log("=".repeat(60));

  // Clean up any previous test session
  const existing = await prisma.customer.findFirst({ where: { phone: PHONE, restaurantId: RESTAURANT_ID } });
  if (existing) {
    await prisma.pendingOrder.deleteMany({ where: { customerId: existing.id } });
    await prisma.message.deleteMany({ where: { customerId: existing.id } });
    await prisma.customer.delete({ where: { id: existing.id } });
    console.log("(cleaned up previous test session)\n");
  }

  // Step 1: First message — greet
  await say("Hi");

  // Step 2: Place an order
  await say("I want 1 chicken biryani for pickup");

  // Step 3: Confirm
  await say("yes confirm");

  // Step 4: Show pending order state (should have razorpay link)
  const customer = await prisma.customer.findFirst({ where: { phone: PHONE, restaurantId: RESTAURANT_ID } });
  if (customer) {
    const pending = await prisma.pendingOrder.findUnique({ where: { customerId: customer.id } });
    if (pending?.razorpayLinkUrl) {
      console.log("\n" + "=".repeat(60));
      console.log("  💳 PAYMENT LINK GENERATED:");
      console.log("  " + pending.razorpayLinkUrl);
      console.log("=".repeat(60));
      console.log("\n  👆 Open that URL and pay to trigger auto-confirmation.");
      console.log("  Watch the admin dashboard Orders tab for the new order.\n");
    } else if (pending?.confirmedOrderId) {
      console.log("\n  ✅ Order already confirmed — ID:", pending.confirmedOrderId);
    } else {
      console.log("\n  ⚠️  No payment link found in pending order. Check bot response above.");
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
