import { DiscordChannelAdapter } from "./channels/discord/index.js";
import { loadConfig } from "./config.js";
import { ProcessManager } from "./opencode/process-manager.js";
import { SessionStore } from "./opencode/session-store.js";

async function main() {
  const config = await loadConfig();
  const discord = config.channels?.discord;
  if (!discord?.enabled) {
    throw new Error("Discord channel is not enabled in config");
  }

  const sessions = new SessionStore();
  const manager = new ProcessManager(config, sessions);
  await manager.initialize();

  const adapter = new DiscordChannelAdapter(discord, manager);
  await adapter.start();

  const shutdown = async () => {
    await adapter.stop();
    await manager.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
