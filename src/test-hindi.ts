import "dotenv/config";
if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;

import { prisma } from "./db.js";
import { handleIncoming } from "./ai/agent.js";

const RESTAURANT_ID = 1;
const HINDI_PHONE = "919000000003"; // fresh phone

async function main() {
  console.log("\n══════════════════════════════════════════");
  console.log("  HINDI LANGUAGE TEST");
  console.log("══════════════════════════════════════════");

  const messages = [
    "bhai mujhe ek mutton curry chahiye",
    "pickup se lunga",
    "haan bilkul confirm karo",
  ];

  for (const text of messages) {
    console.log(`\nUser : ${text}`);
    try {
      const { reply } = await handleIncoming(HINDI_PHONE, text, RESTAURANT_ID);
      reply.split(/\n{2,}/).map(s => s.trim()).filter(Boolean)
        .forEach(b => console.log(`Bot  : ${b}`));
    } catch (e: any) {
      console.error("Error:", e?.message?.slice(0, 120));
      break;
    }
  }

  await prisma.$disconnect();
}

main();
