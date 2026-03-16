import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { checkDiscordAccess, type DiscordChannelConfig } from "../../config.js";
import type { ChannelAdapter } from "../types.js";
import { ProcessManager } from "../../opencode/process-manager.js";
import { globalCronSkillPath, hasGlobalCronSkill } from "../../opencode/skills.js";
import { chunkText } from "./sender.js";
import { CronScheduler } from "../../cron/scheduler.js";
import type { CronJobTarget } from "../../cron/types.js";

const MAX_MESSAGE_LENGTH = 2000;
const INTERACTION_PROGRESS_INITIAL_MS = 20_000;
const INTERACTION_PROGRESS_INTERVAL_MS = 60_000;

function normalizePrompt(input: string): string {
  return input.replace(/<@!?\d+>/g, "").trim();
}
const preview = (text: string, size = 120) => (text.length > size ? `${text.slice(0, size)}...` : text);

function buildCronSkillPrompt(input: {
  task: string;
  guildId: string;
  channelId: string;
  threadId: string | null;
  channelKey: string;
  cronJobsPath: string;
}): string {
  return [
    "请先加载并使用名为 cron 的 skill 来完成任务管理。",
    `你必须通过该 skill 对 ${input.cronJobsPath} 进行增删改查，不要用临时方案。`,
    "schedule 只能是5段cron（min hour day month weekday），严禁使用 @ 开头格式。",
    "如果用户给出具体时刻（如 今天16:20），默认转为每日任务 `20 16 * * *`。",
    `新增任务时必须使用 target: {"guildId":"${input.guildId}","channelId":"${input.channelId}","threadId":${
      input.threadId ? `"${input.threadId}"` : "null"
    }}`,
    `当前会话键: ${input.channelKey}`,
    "禁止反问，信息不足时使用最合理默认值并直接落库。",
    "执行完成后仅输出简短结果（如：已创建 job_xxx / 已更新 job_xxx / 已删除 job_xxx）。",
    "用户请求：",
    input.task,
  ].join("\n");
}

function conversationKey(message: Message): string {
  const guildId = message.guildId || "dm";
  const channelId = message.channel.isThread() ? message.channel.id : message.channelId;
  return `${guildId}:${channelId}`;
}

function interactionKey(interaction: ChatInputCommandInteraction): string {
  const guildId = interaction.guildId || "dm";
  const channelId = interaction.channel?.isThread() ? interaction.channel.id : interaction.channelId;
  return `${guildId}:${channelId}`;
}

function errorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "number" ? value : undefined;
}

function isInteractionTokenError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 10062 || code === 50027;
}

async function sendChunked(
  target: { isSendable: () => boolean; send?: (content: string) => Promise<unknown> },
  text: string,
) {
  const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
  if (!target.isSendable() || typeof target.send !== "function") return;
  for (const chunk of chunks) {
    await target.send(chunk);
  }
}

export class DiscordChannelAdapter implements ChannelAdapter {
  private readonly client: Client;

  constructor(
    private readonly config: DiscordChannelConfig,
    private readonly manager: ProcessManager,
    private readonly cron?: CronScheduler,
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
  }

  async start(): Promise<void> {
    this.client.once(Events.ClientReady, async () => {
      await this.registerCommands();
      console.log(
        `[opencodebot] discord connected as ${this.client.user?.tag}, guilds=${this.client.guilds.cache.size}`,
      );
    });

    this.client.on(Events.MessageCreate, async (message) => {
      await this.handleMessage(message);
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await this.handleCommand(interaction);
    });
    this.client.on(Events.Error, (error) => {
      console.error("[opencodebot] discord client error", error);
    });

    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  async sendCronResult(target: CronJobTarget, text: string): Promise<void> {
    const destinationID = target.threadId || target.channelId;
    const channel = await this.client.channels.fetch(destinationID);
    if (!channel || !("isSendable" in channel) || !channel.isSendable()) return;
    await sendChunked(channel, text);
  }

  private async registerCommands() {
    const commands = [
      new SlashCommandBuilder().setName("new").setDescription("Create a new OpenCode session"),
      new SlashCommandBuilder()
        .setName("plan")
        .setDescription("Run plan-mode request (task optional)")
        .addStringOption((opt) => opt.setName("task").setDescription("Task content to run in plan mode").setRequired(false)),
      new SlashCommandBuilder().setName("compact").setDescription("Run OpenCode compact command"),
      new SlashCommandBuilder().setName("sessions").setDescription("List OpenCode sessions"),
      new SlashCommandBuilder().setName("models").setDescription("List available models"),
      new SlashCommandBuilder()
        .setName("cron")
        .setDescription("Manage cron jobs via cron skill")
        .addStringOption((opt) => opt.setName("task").setDescription("Cron management request").setRequired(true)),
      new SlashCommandBuilder()
        .setName("model")
        .setDescription("Get or set model for this conversation")
        .addStringOption((opt) =>
          opt
            .setName("model")
            .setDescription("provider/model, eg volcengine/glm-4.7")
            .setRequired(false),
        ),
    ].map((cmd) => cmd.toJSON());

    for (const guildId of Object.keys(this.config.guilds || {})) {
      const guild = await this.client.guilds.fetch(guildId);
      await guild.commands.set(commands);
      console.log(`[opencodebot] discord slash commands synced for guild ${guildId}`);
    }
  }

  private resolveInteractionChannel(interaction: ChatInputCommandInteraction) {
    return interaction.channel ?? this.client.channels.fetch(interaction.channelId).catch(() => null);
  }

  private startProgressNotifier(interaction: ChatInputCommandInteraction, key: string): () => void {
    let active = true;
    let interval: NodeJS.Timeout | undefined;
    const startedAt = Date.now();
    const notify = async () => {
      if (!active) return;
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      try {
        await interaction.followUp({
          content: `任务仍在执行（${elapsedSec}s），完成后我会继续回复结果。`,
        });
      } catch (error) {
        if (isInteractionTokenError(error)) {
          console.warn(`[opencodebot] [${key}] interaction token expired during progress update`);
          active = false;
          return;
        }
        console.warn(`[opencodebot] [${key}] failed to send progress update`, error);
      }
    };

    const initial = setTimeout(() => {
      void notify();
      interval = setInterval(() => {
        void notify();
      }, INTERACTION_PROGRESS_INTERVAL_MS);
      interval.unref?.();
    }, INTERACTION_PROGRESS_INITIAL_MS);
    initial.unref?.();

    return () => {
      active = false;
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    };
  }

  private async editReplyOrSend(
    interaction: ChatInputCommandInteraction,
    key: string,
    text: string,
  ): Promise<void> {
    const payload = text.slice(0, MAX_MESSAGE_LENGTH);
    try {
      await interaction.editReply(payload);
      return;
    } catch (error) {
      if (!isInteractionTokenError(error)) {
        throw error;
      }
      console.warn(
        `[opencodebot] [${key}] interaction token expired before editReply, fallback to channel send`,
      );
    }

    const channel = await this.resolveInteractionChannel(interaction);
    if (!channel || !("isSendable" in channel) || !channel.isSendable()) {
      console.error(`[opencodebot] [${key}] fallback send failed: channel unavailable or not sendable`);
      return;
    }
    await sendChunked(channel, payload);
  }

  private async handleMessage(message: Message) {
    if (!message.guildId || message.author.system) return;
    if (message.author.bot && !this.config.allowBots) return;

    const parentId = message.channel.isThread() ? message.channel.parentId : null;
    const access = checkDiscordAccess({
      cfg: this.config,
      guildId: message.guildId,
      channelId: message.channelId,
      parentChannelId: parentId,
      userId: message.author.id,
    });
    const key = conversationKey(message);
    if (!access.allowed) {
      console.log(
        `[opencodebot] [${key}] discord message blocked by allowlist reason=${access.reason ?? "unknown"} from user=${message.author.id} channel=${message.channelId}`,
      );
      return;
    }
    if (access.requireMention && !message.mentions.has(this.client.user!.id)) {
      console.log(`[opencodebot] [${key}] discord message ignored (mention required)`);
      return;
    }

    const text = normalizePrompt(message.content);
    if (!text) return;

    try {
      console.log(
        `[opencodebot] [${key}] discord -> opencode from ${message.author.username}: "${preview(text)}"`,
      );
      if ("sendTyping" in message.channel && typeof message.channel.sendTyping === "function") {
        await message.channel.sendTyping();
      }
      const reply = await this.manager.prompt(key, text, access.systemPrompt);
      console.log(`[opencodebot] [${key}] opencode -> discord: "${preview(reply)}"`);
      await sendChunked(message.channel, reply);
    } catch (error) {
      await message.reply(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleCommand(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId || !interaction.channelId) return;
    const channel =
      interaction.channel ?? (await this.client.channels.fetch(interaction.channelId).catch(() => null));
    const parentId = channel?.isThread() ? channel.parentId : null;
    const access = checkDiscordAccess({
      cfg: this.config,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      parentChannelId: parentId,
      userId: interaction.user.id,
    });
    if (!access.allowed) {
      const reason =
        access.reason === "user_not_allowed"
          ? "user is not in guild.users allowlist"
          : access.reason === "channel_not_allowed"
            ? "channel/thread is not in guild.channels allowlist"
            : "guild is not configured in allowlist";
      try {
        await interaction.reply({ content: `Not allowed here (${reason}).`, flags: MessageFlags.Ephemeral });
      } catch (error) {
        if (isInteractionTokenError(error)) {
          console.warn(`[opencodebot] interaction denied but token already expired`);
          return;
        }
        throw error;
      }
      return;
    }

    const key = interactionKey(interaction);
    try {
      await interaction.deferReply();
    } catch (error) {
      const code = errorCode(error);
      if (code === 10062) {
        console.warn(
          `[opencodebot] [${key}] slash /${interaction.commandName} defer failed: unknown interaction (expired/invalid token)`,
        );
        return;
      }
      throw error;
    }
    const stopProgress = this.startProgressNotifier(interaction, key);
    try {
      if (interaction.commandName === "new") {
        console.log(`[opencodebot] [${key}] discord slash /new`);
        const sessionID = await this.manager.resetSession(key);
        await this.editReplyOrSend(interaction, key, `Started new session: \`${sessionID}\``);
        return;
      }
      if (interaction.commandName === "plan") {
        const task = interaction.options.getString("task");
        if (task?.trim()) {
          console.log(`[opencodebot] [${key}] discord slash /plan task="${preview(task)}"`);
          const output = await this.manager.promptPlan(key, task.trim());
          await this.editReplyOrSend(interaction, key, output);
        } else {
          console.log(`[opencodebot] [${key}] discord slash /plan (no task)`);
          const output = await this.manager.runSlashCommand(key, "plan");
          await this.editReplyOrSend(interaction, key, output);
        }
        return;
      }
      if (interaction.commandName === "compact") {
        console.log(`[opencodebot] [${key}] discord slash /compact`);
        const output = await this.manager.runSlashCommand(key, "compact");
        await this.editReplyOrSend(interaction, key, output);
        return;
      }
      if (interaction.commandName === "sessions") {
        console.log(`[opencodebot] [${key}] discord slash /sessions`);
        const sessions = await this.manager.listSessions(key);
        const summary =
          sessions.slice(0, 10).map((s) => `- ${s.id} ${s.title || ""}`).join("\n") || "(none)";
        await this.editReplyOrSend(interaction, key, summary);
        return;
      }
      if (interaction.commandName === "cron") {
        if (!this.cron?.enabled) {
          await this.editReplyOrSend(interaction, key, "Cron is disabled in config.");
          return;
        }
        try {
          if (!(await hasGlobalCronSkill())) {
            throw new Error("missing");
          }
        } catch {
          await this.editReplyOrSend(interaction, key, `cron skill 不存在: \`${globalCronSkillPath()}\`，请先重新下发 skills/cron。`);
          return;
        }
        const task = interaction.options.getString("task", true).trim();
        console.log(`[opencodebot] [${key}] discord slash /cron task="${preview(task)}"`);
        const output = await this.manager.prompt(
          key,
          buildCronSkillPrompt({
            task,
            guildId: interaction.guildId,
            channelId: interaction.channel?.isThread() ? (interaction.channel.parentId || interaction.channelId) : interaction.channelId,
            threadId: interaction.channel?.isThread() ? interaction.channelId : null,
            channelKey: key,
            cronJobsPath: this.cron.jobsPath,
          }),
        );
        const reconcile = await this.cron.reconcileJobSchedules();
        console.log(
          `[opencodebot] [${key}] /cron reconcile converted=${reconcile.converted.length} invalid=${reconcile.invalid.length}`,
        );
        if (reconcile.invalid.length > 0) {
          await this.editReplyOrSend(
            interaction,
            key,
            `cron 写入了不支持的 schedule（任务: ${reconcile.invalid.join(", ")}），请改成5段cron再重试。`,
          );
          return;
        }
        await this.editReplyOrSend(interaction, key, output);
        return;
      }
      if (interaction.commandName === "model") {
        const name = interaction.options.getString("model") || interaction.options.getString("name");
        if (name) {
          console.log(`[opencodebot] [${key}] discord slash /model ${name}`);
          await this.manager.setModel(key, name);
          const model = await this.manager.getModel(key);
          console.log(
            `[opencodebot] [${key}] /model applied. requested="${name}" effective="${model.override ?? "none"}"`,
          );
          await this.editReplyOrSend(interaction, key, `Model override set to: \`${model.override ?? name}\``);
        } else {
          console.log(`[opencodebot] [${key}] discord slash /model`);
          const model = await this.manager.getModel(key);
          console.log(
            `[opencodebot] [${key}] /model query. override="${model.override ?? "none"}" current="${model.current ?? "unknown"}"`,
          );
          await this.editReplyOrSend(
            interaction,
            key,
            `Model override: \`${model.override ?? "(none)"}\`\nCurrent model: \`${model.current ?? "(unknown)"}\``,
          );
        }
        return;
      }
      if (interaction.commandName === "models") {
        console.log(`[opencodebot] [${key}] discord slash /models`);
        const models = await this.manager.listModels(key);
        const text = models.length ? models.map((m) => `- ${m}`).join("\n") : "(no models)";
        await this.editReplyOrSend(interaction, key, text);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[opencodebot] [${key}] discord slash /${interaction.commandName} failed: ${message}`,
        error,
      );
      try {
        if (interaction.replied || interaction.deferred) {
          await this.editReplyOrSend(interaction, key, `Error: ${message}`);
        } else {
          await interaction.reply({ content: `Error: ${message}` });
        }
      } catch (replyError) {
        console.error(`[opencodebot] [${key}] failed to send slash error reply`, replyError);
      }
    } finally {
      stopProgress();
    }
  }
}
