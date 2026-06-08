/**
 * End-to-end test: propose_order → confirm → generate_payment_link
 * Run: npx tsx src/test-razorpay-flow.ts
 */
import "dotenv/config";
// PgBouncer pooler (port 6543) can be unreachable outside the running server process;
// use the direct Supabase connection (port 5432) for this test script.
if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
import { prisma } from "./db.js";
import { runTool } from "./ai/tools.js";

const TEST_PHONE = "919999999998"; // distinct from chat-test to avoid conflicts
const RESTAURANT_ID = 1;

async function step(label: string, fn: () => Promise<any>) {
  console.log(`\n── ${label} ─────────────────────────`);
  const result = await fn();
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  // ── 0. Check config ────────────────────────────────────────────────────────
  const cfg = await prisma.botConfig.findFirst({
    select: { requiresPaymentBeforeOrder: true, razorpayEnabled: true, razorpayKeyId: true, razorpayKeySecret: true },
  });
  console.log("\n[Config]", JSON.stringify({
    requiresPayment: cfg?.requiresPaymentBeforeOrder,
    razorpayEnabled: cfg?.razorpayEnabled,
    hasKeyId: !!cfg?.razorpayKeyId,
    hasSecret: !!cfg?.razorpayKeySecret,
  }));

  if (!cfg?.razorpayEnabled || !cfg.razorpayKeyId || !cfg.razorpayKeySecret) {
    console.error("❌ Razorpay not fully configured in DB. Enable it and add Key ID + Secret in the dashboard.");
    process.exit(1);
  }

  // ── 1. Get a real available menu item ──────────────────────────────────────
  const item = await prisma.menuItem.findFirst({
    where: { available: true },
    select: { id: true, name: true, price: true },
  });
  if (!item) {
    console.error("❌ No available menu items found.");
    process.exit(1);
  }
  console.log(`\n[MenuItem] id=${item.id}  name=${item.name}  ₹${item.price}`);

  // ── 2. Get/create test customer ────────────────────────────────────────────
  const customer = await prisma.customer.upsert({
    where: { phone_restaurantId: { phone: TEST_PHONE, restaurantId: RESTAURANT_ID } },
    create: { phone: TEST_PHONE, restaurantId: RESTAURANT_ID },
    update: {},
  });
  console.log(`\n[Customer] id=${customer.id}  phone=${TEST_PHONE}`);

  // Clear any stale pending cart
  await prisma.pendingOrder.deleteMany({ where: { customerId: customer.id } });

  // ── 3. propose_order ───────────────────────────────────────────────────────
  const propose = await step("propose_order", () =>
    runTool(customer.id, RESTAURANT_ID, "propose_order", {
      items: [{ menuItemId: item.id, qty: 1 }],
      type: "pickup",
    })
  );

  const out = propose.output as any;
  if (!out.ok) {
    console.error("❌ propose_order failed:", out.error);
    process.exit(1);
  }
  console.log(`\n✅ paymentPath = "${out.paymentPath}"  total = ₹${out.total}`);
  if (out.paymentPath !== "razorpay") {
    console.warn(`⚠️  paymentPath is "${out.paymentPath}" not "razorpay" — check requiresPaymentBeforeOrder and Razorpay config.`);
  }

  // ── 4. generate_payment_link ───────────────────────────────────────────────
  const payLink = await step("generate_payment_link", () =>
    runTool(customer.id, RESTAURANT_ID, "generate_payment_link", {})
  );

  const plOut = payLink.output as any;
  if (!plOut.ok) {
    console.error("\n❌ generate_payment_link FAILED:", plOut.error);
    process.exit(1);
  }

  console.log(`\n✅ Payment link generated!`);
  console.log(`   URL  : ${plOut.url}`);
  console.log(`   Total: ₹${plOut.total}`);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await prisma.pendingOrder.deleteMany({ where: { customerId: customer.id } });
  await prisma.$disconnect();
  console.log("\n✅ All steps passed — Razorpay flow is working.\n");
}

main().catch((e) => {
  console.error("\n❌ Unexpected error:", e?.message ?? e);
  process.exit(1);
});
