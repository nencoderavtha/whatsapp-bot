import { config } from "./config.js";
import { buildAdminApp } from "./admin/server.js";
import { runBot } from "./whatsapp/run.js";

async function main() {
  // Admin portal
  const server = buildAdminApp().listen(config.adminPort, () => {
    console.log(`🛠️  Admin portal: http://localhost:${config.adminPort}  (password in .env)`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\n❌ Port ${config.adminPort} is already in use — the bot is probably already running in another terminal.\n` +
          `   Close that one, or change ADMIN_PORT in .env, then try again.\n`,
      );
      process.exit(1);
    }
    throw err;
  });

  // WhatsApp bot
  await runBot();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
