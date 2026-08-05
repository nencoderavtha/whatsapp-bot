import { config } from "./config.js";
import { buildAdminApp } from "./admin/server.js";
import { runBot } from "./whatsapp/run.js";
import { logger } from './services/logger.js';

// Prevent transient DB errors (e.g. Supabase pooler timeout) from crashing the process.
// Express 4 async route handlers that throw become unhandled rejections without explicit
// try/catch — this is the safety net so the bot stays alive.
process.on("unhandledRejection", (reason) => {
  logger.error("⚠️  Unhandled rejection (process continues):", reason);
});

async function main() {
  // Admin portal
  const server = buildAdminApp().listen(config.adminPort, "0.0.0.0", () => {
    // 0.0.0.0 is the bind address, not somewhere you can browse to. On Cloud Run
    // the reachable address is SERVER_URL, so log that when it's set.
    const portalUrl = process.env.SERVER_URL ?? `http://localhost:${config.adminPort}`;
    logger.info(`🛠️  Admin portal listening on :${config.adminPort} — ${portalUrl}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error(
        `\n❌ Port ${config.adminPort} is already in use — the bot is probably already running in another terminal.\n` +
          `   Close that one, or change ADMIN_PORT in .env, then try again.\n`,
      );
      process.exit(1);
    }
    throw err;
  });

  // WhatsApp bot. A bot startup failure (bad DB schema, missing WhatsApp creds)
  // must not take the admin portal down with it — the portal is where you go to
  // fix that configuration, and on Cloud Run exiting here becomes a crash loop.
  try {
    await runBot();
  } catch (e) {
    logger.error(
      "❌ Bot failed to start — admin portal stays up so config can be fixed:",
      e,
    );
  }
  // Graceful shutdown handling for Cloud Run / Railway / Docker
  const shutdown = async (signal: string) => {
    logger.info(`🛑 Received ${signal} — starting graceful shutdown...`);
    server.close(async () => {
      logger.info("   HTTP server closed.");
      try {
        const { prisma } = await import("./db.js");
        await prisma.$disconnect();
        logger.info("   Database connections disconnected.");
      } catch {}
      process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown stalls
    setTimeout(() => {
      logger.warn("⚠️ Forced shutdown timeout reached. Exiting.");
      process.exit(1);
    }, 10000).unref();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  logger.error("Fatal:", e);
  process.exit(1);
});
