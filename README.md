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
```

## Behavior

- One Discord channel/thread maps to one OpenCode server process.
- Channel/thread to session mapping is persisted in `~/.opencodebot/sessions.json`.
- On process restart, bot tries to recover previous session by session ID.
- Slash commands: `/new`, `/plan`, `/compact`, `/sessions`, `/models`, `/model`.

### Slash command notes

- `/plan task:<text>` uses OpenCode native plan agent (`agent: "plan"`).
- `/models` lists currently available models from OpenCode `/config/providers`.
- `/model model:<provider/model>` sets model override for current conversation.
- `/model model:<modelID>` is also supported (provider inferred from current session/override).
