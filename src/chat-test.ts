import readline from "node:readline";
import { config } from "./config.js";
import { handleIncoming } from "./ai/agent.js";
import { getActiveRestaurant } from "./services/restaurant.js";

/**
 * Terminal chat tester — talk to the bot without WhatsApp.
 * Run: npm run chat
 * Uses a fake phone number so it builds real customer memory in the DB.
 */
const FAKE_PHONE = "919999999999";

async function main() {
  if (!config.aiApiKey) {
    console.error(
      `❌ No AI key set for provider "${config.aiProvider}". Set GROQ_API_KEY or CEREBRAS_API_KEY in .env.`,
    );
    process.exit(1);
  }

  const restaurant = await getActiveRestaurant();
  const restaurantId = restaurant.id;

  console.log(`(using ${config.aiProvider} · ${config.aiModel})`);
  console.log(`🍗 Chatting with ${restaurant.restaurantName} (type 'exit' to quit)\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () =>
    rl.question("You: ", async (text) => {
      if (text.trim().toLowerCase() === "exit") return rl.close();
      try {
        const { reply, placedOrderId } = await handleIncoming(FAKE_PHONE, text.trim(), restaurantId);
        // Show each blank-line-separated part as its own bubble (like WhatsApp will).
        const bubbles = reply.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
        console.log();
        for (const b of bubbles.length ? bubbles : [reply]) console.log(`Rajamma: ${b}`);
        if (placedOrderId) console.log(`   [✅ order #${placedOrderId} placed]`);
        console.log();
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (e?.status === 429 || msg.includes("rate_limit") || msg.includes("429")) {
          const m = msg.match(/try again in ([\dhms.]+)/i);
          const tpd = /per day|TPD/i.test(msg);
          console.log(
            `\n⚠️  Groq rate limit hit${tpd ? " (daily free-tier token cap)" : ""}.` +
              (m ? ` Try again in ${m[1]}.` : "") +
              `\n   Free tier is for demo/testing only — add billing at https://console.groq.com/settings/billing for real volume.\n`,
          );
        } else {
          console.error("Error:", msg);
        }
      }
      ask();
    });
  ask();
}

main();
