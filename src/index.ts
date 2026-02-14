import { DiscordChannelAdapter } from "./channels/discord/index.js";
import { loadConfig } from "./config.js";
import { CronScheduler, defaultCronOptions } from "./cron/scheduler.js";
import { ProcessManager } from "./opencode/process-manager.js";
import { SessionStore } from "./opencode/session-store.js";
import { syncCronSkillToGlobal } from "./opencode/skills.js";

async function main() {
  const config = await loadConfig();
  const discord = config.channels?.discord;
  if (!discord?.enabled) {
    throw new Error("Discord channel is not enabled in config");
  }
  try {
    await syncCronSkillToGlobal();
  } catch (error) {
    console.warn("[opencodebot] failed to sync cron skill", error);
  }

  const sessions = new SessionStore();
  const manager = new ProcessManager(config, sessions);
  await manager.initialize();

  let adapter: DiscordChannelAdapter;
  const cron = new CronScheduler({
    ...defaultCronOptions(config.cron || {}),
    runPrompt: async ({ channelKey, prompt, systemPrompt }) => await manager.prompt(channelKey, prompt, systemPrompt),
    notify: async (target, text) => {
      if (!adapter) return;
      await adapter.sendCronResult(target, text);
    },
  });

  adapter = new DiscordChannelAdapter(discord, manager, cron);
  await adapter.start();
  await cron.start();

  const shutdown = async () => {
    await cron.stop();
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
