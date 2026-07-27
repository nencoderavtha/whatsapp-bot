import { config } from "../config.js";
import { botSessionManager } from "./session-manager.js";
import { logger } from '../services/logger.js';

export async function runBot() {
  if (!config.aiApiKey) {
    logger.warn(
      `⚠️  No AI key set for provider "${config.aiProvider}" — the bot can't generate replies.\n` +
      "   Groq: https://console.groq.com/keys  |  OpenRouter: https://openrouter.ai/keys",
    );
  }

  await botSessionManager.startAll();

  if (botSessionManager.count === 0) {
    logger.warn("⚠️  No active restaurants found in DB. Add a BotConfig row with isActive=true.");
  }
}

runBot().catch((e) => {
  logger.error(e);
  process.exit(1);
});
