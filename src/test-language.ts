import "dotenv/config";
if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;

import { prisma } from "./db.js";
import { handleIncoming } from "./ai/agent.js";

const RESTAURANT_ID = 1;
const TENGLISH_PHONE = "919000000001";
const HINDI_PHONE    = "919000000002";

async function chat(phone: string, messages: string[], label: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${label}`);
  console.log("═".repeat(60));

  // Best-effort cleanup — skip if DB unreachable
  try {
    const cust = await prisma.customer.findFirst({ where: { phone, restaurantId: RESTAURANT_ID } });
    if (cust) {
      await prisma.message.deleteMany({ where: { customerId: cust.id } });
      await prisma.pendingOrder.deleteMany({ where: { customerId: cust.id } });
    }
  } catch { /* ignore — test proceeds with existing history */ }

  for (const text of messages) {
    console.log(`\nUser : ${text}`);
    const { reply } = await handleIncoming(phone, text, RESTAURANT_ID);
    const bubbles = reply.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    for (const b of bubbles) console.log(`Bot  : ${b}`);
  }
}

async function main() {
  await chat(TENGLISH_PHONE, [
    "bhai oka chicken biryani kavali",
    "pickup cheyyali",
    "confirm cheyyi",
  ], "🟠 TENGLISH TEST");

  await chat(HINDI_PHONE, [
    "bhai ek mutton curry chahiye",
    "pickup se lunga",
    "haan confirm karo",
  ], "🟢 HINDI TEST");

  await prisma.$disconnect();
}

main().catch(e => { console.error(e?.message ?? e); process.exit(1); });
