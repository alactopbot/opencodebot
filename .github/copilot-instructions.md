# Copilot Instructions for opencodebot

## Overview

**opencodebot** is a Discord channel gateway for [OpenCode](https://github.com/opencode-ai/opencode), enabling conversational AI capabilities within Discord. The bot creates isolated OpenCode server processes per channel/thread and manages them via Discord slash commands. It also includes an optional cron scheduler for automated task execution.

## Build, Test, and Lint

### TypeScript Compilation
```bash
npm run build          # Compile src/ to dist/ (ES2022, strict mode)
```

### Development
```bash
npm run dev            # Run directly from TypeScript (via tsx)
npm start              # Run compiled dist/index.js
```

### Testing
No formal test suite is configured. Verify changes by:
1. Building: `npm run build`
2. Running locally with a test Discord token and guild configuration
3. Testing slash commands in Discord and verifying process lifecycle

### Linting
No linter is configured. Use TypeScript's strict mode (`tsconfig.json`) for type checking.

## High-Level Architecture

The bot has 4 main layers, with **one opencode process per bot instance** shared across all channels:

### 1. **Entry Point** (`src/index.ts`)
- Installs timestamped console logging
- Loads configuration from `~/.opencodebot/config.json`
- Initializes core managers: `ProcessManager`, `DiscordChannelAdapter`, `CronScheduler`
- Handles SIGINT/SIGTERM for graceful shutdown

### 2. **Discord Channel Adapter** (`src/channels/discord/index.ts`)
- Implements `ChannelAdapter` interface
- Listens for Discord messages and slash commands
- Enforces access control via `checkDiscordAccess()` (guild allowlist, user allowlist, system prompts)
- Supports slash commands: `/new`, `/plan`, `/compact`, `/sessions`, `/models`, `/model`, `/cron`
- Handles message chunking (2000 char limit per Discord message)
- Routes cron tasks through special prompt builder

### 3. **OpenCode Process Manager** (`src/opencode/process-manager.ts`)
**Single-process architecture**: one `opencode serve` process per bot instance, shared across all guilds/channels.

Key types:
- `SharedRuntime` — the single opencode process (baseUrl, pid, mainSessionID, single SSE stream, sessionIndex)
- `ChannelEntry` — per-channel state (sessionID as child of mainSessionID, model override, message ordering)

Session hierarchy:
```
opencode serve (唯一进程)
└── main session [主 agent: quality control / delegation judge]
    ├── guild:channel-A session [child agent: tool execution]
    └── guild:channel-B session [child agent: tool execution]
```

**Messages go directly to the channel's child session** — the main session exists only as a structural parent (`parentID` for child sessions) and does not intercept messages. Main agent routing is reserved for future use (`mainAgentSystemPrompt` / `delegationToken` config fields have no effect currently).

**Idle timeout** — monitors last activity time across all sessions; when the entire process has been idle > `runtimeIdleTimeoutMs` with no pending prompts, kills the shared process. Sessions are restored from `sessions.json` on next activation.

**Single SSE stream** — one `/event` SSE connection to the shared process; `sessionIndex: Map<sessionID, channelKey | "__main__">` dispatches events to the correct `SessionMessageState`.

### 4. **Cron Scheduler** (`src/cron/scheduler.ts`)
- Optional job scheduler stored in `~/.opencodebot/cron/jobs.json`
- Parses 5-segment cron expressions (no `@` aliases allowed)
- Executes jobs by calling `ProcessManager.prompt()` with system prompt
- Tracks job runs in `~/.opencodebot/cron/runs/*.jsonl`
- Supports catch-up window for missed runs on restart
- Allows max concurrent runs to prevent overload

### Data Flow
1. Discord message/command → `DiscordChannelAdapter`
2. Adapter calls `ProcessManager.prompt(channelKey, prompt, systemPrompt)`
3. Manager ensures `SharedRuntime` is alive (lazy start / session recovery)
4. Ensures `ChannelEntry` exists for channel (child session with `parentID = mainSessionID`)
5. Message dispatched directly to channel's child session via SSE stream
6. Response collected via SSE stream, dispatched by sessionIndex
7. Response chunks sent back to Discord

### Multi-bot Topology
Running multiple opencodebot instances (each with its own config + Discord bot token) means each has exactly one opencode process. Resources scale as `N_bots × 1_process` instead of `N_bots × N_channels_per_bot × 1_process`.

## Key Conventions

### Configuration Files
- **Location**: `~/.opencodebot/config.json` (loaded at startup)
- **Template**: `config.example.json` in repo root
- **Structure**: `AppConfig` (Discord, OpenCode, cron sections)
- **Persistence**: Channel-to-session mapping in `~/.opencodebot/sessions.json` (recovered on restart)

### Access Control
- **Function**: `checkDiscordAccess()` in `src/config.ts`
- **Rules**: Guild-level and channel-level (allowlist or all), optional user allowlist, per-channel system prompts
- **Enforcement**: All messages/commands checked before routing to ProcessManager

### Channel Keys
- Format: `guildId:channelId` (or `dm:channelId` for DMs)
- Used everywhere: routing, session recovery, cron targets
- Derived from Discord message/interaction context

### Session Recovery
- `SessionStore` now stores both `mainSessionID` (top-level) and per-channel session records under `channels`
- **Migration**: old flat `sessions.json` format (Record<channelKey, SessionRecord>) is auto-migrated to new format on load
- On bot restart, `SharedRuntime` restores main session and all channel child sessions by their saved IDs
- If a session ID no longer exists on the new process, a fresh session is created

### Message Ordering & Streaming
- Single SSE `/event` stream for the entire shared process
- `sessionIndex: Map<sessionID, channelKey | "__main__">` routes events to the correct `SessionMessageState`
- Each `SessionMessageState` has its own `messageOrder[]`, `messageTexts` Map, and `pendingPrompts[]`
- `latestMessageID` tracks the last received message; `pickCompletedMessage` finds the newest message after baseline

### Main Agent (Reserved for Future Use)
- Config fields `mainAgentSystemPrompt` and `delegationToken` exist but have no runtime effect currently
- `mainSessionID` / `mainState` / `MAIN_KEY` are preserved in `ProcessManager` as structural scaffolding
- When enabled in future: main session would intercept messages first; delegation token (`[→SUBAGENT]`) signals forwarding to child session

### Cron Job Target Format
```json
{
  "guildId": "...",
  "channelId": "...",
  "threadId": null  // or specific thread ID
}
```

### Type Module System
- Uses `"type": "module"` in `package.json` and `"module": "NodeNext"` in `tsconfig.json`
- All imports include `.js` extension (for ESM compatibility)
- No CommonJS requires

### Error Handling Patterns
- Startup errors: throw to exit (require manual config fix)
- Streaming errors: logged, continue with next response batch
- Process close errors: logged, mark session as closed
- Discord send failures: logged, message lost (not retried)

### Special Strings & Prefixes
- `[opencodebot]` prefix in logs
- Mention regex in `normalizePrompt()`: strips `<@!?\\d+>` patterns
- Cron skill prompt is localized in Chinese with specific directives

## Development Notes

- Modify `skillPath` in config to point custom skills to OpenCode's global skill directory
- `runtimeIdleTimeoutMs` (default 30m) controls channel inactivity timeout
- `ProcessManager.pendingPrompts` uses timers (default 5 min) to detect stuck requests
- Cron jobs run with isolated session contexts (not tied to Discord channel sessions)
- If global cron skill is missing, `/cron` command returns explicit error
