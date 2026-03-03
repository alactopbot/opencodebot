import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export type ChannelRule = {
  allow?: boolean;
  systemPrompt?: string;
};

export type GuildRule = {
  requireMention?: boolean;
  users?: string[];
  channels?: Record<string, ChannelRule>;
};

export type DiscordChannelConfig = {
  enabled: boolean;
  token: string;
  allowBots?: boolean;
  groupPolicy?: "allowlist" | "all";
  guilds?: Record<string, GuildRule>;
};

export type AppConfig = {
  opencode?: {
    hostname?: string;
    projectDirectory?: string;
    autoApprovePermissions?: boolean;
    runtimeIdleTimeoutMs?: number;
    auth?: {
      username?: string;
      password?: string;
    };
  };
  cron?: {
    enabled?: boolean;
    maxConcurrentRuns?: number;
    catchUpWindowMinutes?: number;
    maxCatchUpRunsPerJob?: number;
    defaultTimeoutMs?: number;
  };
  channels?: {
    discord?: DiscordChannelConfig;
  };
};

export type AccessResult = {
  allowed: boolean;
  requireMention: boolean;
  systemPrompt?: string;
};

export const CONFIG_PATH = join(homedir(), ".opencodebot", "config.json");

export async function loadConfig(path = CONFIG_PATH): Promise<AppConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as AppConfig;
  if (!parsed.channels?.discord?.enabled) {
    throw new Error("channels.discord.enabled must be true in config");
  }
  if (!parsed.channels.discord.token) {
    throw new Error("channels.discord.token is required in config");
  }
  return parsed;
}

export function checkDiscordAccess(input: {
  cfg: DiscordChannelConfig;
  guildId: string;
  channelId: string;
  parentChannelId?: string | null;
  userId: string;
}): AccessResult {
  const guild = input.cfg.guilds?.[input.guildId];
  if (!guild) return { allowed: false, requireMention: false };

  if (guild.users?.length && !guild.users.includes(input.userId)) {
    return { allowed: false, requireMention: !!guild.requireMention };
  }

  if (input.cfg.groupPolicy === "allowlist") {
    const direct = guild.channels?.[input.channelId];
    const parent = input.parentChannelId ? guild.channels?.[input.parentChannelId] : undefined;
    const resolved = direct ?? parent;
    if (!resolved?.allow) {
      return { allowed: false, requireMention: !!guild.requireMention };
    }
    return {
      allowed: true,
      requireMention: !!guild.requireMention,
      systemPrompt: resolved.systemPrompt,
    };
  }

  return { allowed: true, requireMention: !!guild.requireMention };
}
