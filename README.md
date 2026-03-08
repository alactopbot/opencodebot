# opencodebot

Channel gateway for OpenCode (Discord first, extensible later).

## Configure

```bash
mkdir -p ~/.opencodebot
cp config.example.json ~/.opencodebot/config.json
```

Edit `~/.opencodebot/config.json` with your Discord token and allowlist.

Placeholder guide in `config.example.json`:

- `YOUR_GUILD_ID`: Discord server ID
- `YOUR_USER_ID`: your Discord user ID (or remove `users` to allow all in guild rule)
- `YOUR_CHANNEL_ID_1/2/3`: allowed channel IDs
- `${WORKSPACE_DIR}`: your workspace root path
- `${SKILL_PATH}`: optional skill/instruction path

## Run

```bash
npm run build
npm start
# or with a custom config path:
./start.sh /path/to/my-bot/config.json
```

## Multiple Bot Instances

Each bot instance reads from a single config file. The directory containing the config file is the bot's home — all data (`sessions.json`, `cron/`) lives there.

```bash
# Bot 1: coding assistant
mkdir -p ~/.opencodebot/coding-bot
cp config.example.json ~/.opencodebot/coding-bot/config.json
# edit ~/.opencodebot/coding-bot/config.json with bot1 token
./start.sh ~/.opencodebot/coding-bot/config.json

# Bot 2: docs assistant
mkdir -p ~/.opencodebot/docs-bot
cp config.example.json ~/.opencodebot/docs-bot/config.json
# edit ~/.opencodebot/docs-bot/config.json with bot2 token
./start.sh ~/.opencodebot/docs-bot/config.json
```

Each instance has its own:
- `config.json` — Discord token, guilds, channel rules
- `sessions.json` — channel → OpenCode session mapping
- `cron/jobs.json` — scheduled tasks
- `output.log` — runtime log

## Behavior

- One Discord channel/thread maps to one OpenCode child session (shared single opencode process per bot instance).
- Channel/thread to session mapping is persisted in `<home>/sessions.json`.
- On process restart, bot tries to recover previous session by session ID.
- Slash commands: `/new`, `/plan`, `/compact`, `/sessions`, `/models`, `/model`, `/cron`.
- Cron scheduler is optional (`cron.enabled=true`) and stores jobs in `<home>/cron/jobs.json`, runs in `<home>/cron/runs/*.jsonl`.
- Built-in repo skill `skills/cron` is synced to global OpenCode path `~/.config/opencode/skills/cron` on startup.

### Slash command notes

- `/plan task:<text>` uses OpenCode native plan agent (`agent: "plan"`).
- `/models` lists currently available models from OpenCode `/config/providers`.
- `/model model:<provider/model>` sets model override for current conversation.
- `/model model:<modelID>` is also supported (provider inferred from current session/override).
- `/cron task:<text>` delegates cron management to OpenCode `cron` skill.

### Cron creation in conversation

- Use `/cron task:<自然语言需求>` to force OpenCode to load and use `cron` skill.
- `cron` skill manages `<home>/cron/jobs.json` directly (add/list/update/remove).
- If the global cron skill file is missing, `/cron` returns an explicit error.
