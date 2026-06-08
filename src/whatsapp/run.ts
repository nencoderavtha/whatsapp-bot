import { config } from "../config.js";
import { botSessionManager } from "./session-manager.js";

export async function runBot() {
  if (!config.aiApiKey) {
    console.warn(
      `⚠️  No AI key set for provider "${config.aiProvider}" — the bot can't generate replies.\n` +
      "   Groq: https://console.groq.com/keys  |  OpenRouter: https://openrouter.ai/keys",
    );
  }

  await botSessionManager.startAll();

  if (botSessionManager.count === 0) {
    console.warn("⚠️  No active restaurants found in DB. Add a BotConfig row with isActive=true.");
  }
}

runBot().catch((e) => {
  console.error(e);
  process.exit(1);
});
