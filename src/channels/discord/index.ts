import { ChatInputCommandInteraction, Client, Events, GatewayIntentBits, Message, SlashCommandBuilder } from "discord.js";
import { checkDiscordAccess, type DiscordChannelConfig } from "../../config.js";
import type { ChannelAdapter } from "../types.js";
import { ProcessManager } from "../../opencode/process-manager.js";
import { chunkText } from "./sender.js";

const MAX_MESSAGE_LENGTH = 2000;

function normalizePrompt(input: string): string {
  return input.replace(/<@!?\d+>/g, "").trim();
}
const preview = (text: string, size = 120) => (text.length > size ? `${text.slice(0, size)}...` : text);

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

async function sendChunked(target: Message["channel"], text: string) {
  const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
  if (!target.isSendable()) return;
  for (const chunk of chunks) {
    await target.send(chunk);
  }
}

export class DiscordChannelAdapter implements ChannelAdapter {
  private readonly client: Client;

  constructor(
    private readonly config: DiscordChannelConfig,
    private readonly manager: ProcessManager,
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

    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private async registerCommands() {
    const commands = [
      new SlashCommandBuilder().setName("new").setDescription("Create a new OpenCode session"),
      new SlashCommandBuilder().setName("compact").setDescription("Run OpenCode compact command"),
      new SlashCommandBuilder().setName("sessions").setDescription("List OpenCode sessions"),
      new SlashCommandBuilder().setName("models").setDescription("List available models"),
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
        `[opencodebot] [${key}] discord message blocked by allowlist from user=${message.author.id} channel=${message.channelId}`,
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
    const parentId = interaction.channel?.isThread() ? interaction.channel.parentId : null;
    const access = checkDiscordAccess({
      cfg: this.config,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      parentChannelId: parentId,
      userId: interaction.user.id,
    });
    if (!access.allowed) {
      await interaction.reply({ content: "Not allowed here.", ephemeral: true });
      return;
    }

    const key = interactionKey(interaction);
    try {
      if (interaction.commandName === "new") {
        console.log(`[opencodebot] [${key}] discord slash /new`);
        const sessionID = await this.manager.resetSession(key);
        await interaction.reply(`Started new session: \`${sessionID}\``);
        return;
      }
      if (interaction.commandName === "compact") {
        console.log(`[opencodebot] [${key}] discord slash /compact`);
        const output = await this.manager.runSlashCommand(key, "compact");
        await interaction.reply(output.slice(0, MAX_MESSAGE_LENGTH));
        return;
      }
      if (interaction.commandName === "sessions") {
        console.log(`[opencodebot] [${key}] discord slash /sessions`);
        const sessions = await this.manager.listSessions(key);
        const summary =
          sessions.slice(0, 10).map((s) => `- ${s.id} ${s.title || ""}`).join("\n") || "(none)";
        await interaction.reply(summary.slice(0, MAX_MESSAGE_LENGTH));
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
          await interaction.reply(`Model override set to: \`${model.override ?? name}\``);
        } else {
          console.log(`[opencodebot] [${key}] discord slash /model`);
          const model = await this.manager.getModel(key);
          console.log(
            `[opencodebot] [${key}] /model query. override="${model.override ?? "none"}" current="${model.current ?? "unknown"}"`,
          );
          await interaction.reply(
            `Model override: \`${model.override ?? "(none)"}\`\nCurrent model: \`${model.current ?? "(unknown)"}\``,
          );
        }
        return;
      }
      if (interaction.commandName === "models") {
        console.log(`[opencodebot] [${key}] discord slash /models`);
        const models = await this.manager.listModels(key);
        const text = models.length ? models.map((m) => `- ${m}`).join("\n") : "(no models)";
        await interaction.reply(text.slice(0, MAX_MESSAGE_LENGTH));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[opencodebot] [${key}] discord slash /${interaction.commandName} failed: ${message}`,
        error,
      );
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(`Error: ${message}`);
      } else {
        await interaction.reply(`Error: ${message}`);
      }
    }
  }
}
