# opencodebot

Channel gateway for OpenCode (Discord first, extensible later).

## Configure

```bash
mkdir -p ~/.opencodebot
cp config.example.json ~/.opencodebot/config.json
```

Edit `~/.opencodebot/config.json` with your Discord token and allowlist.

## Run

```bash
npm run build
npm start
```

## Behavior

- One Discord channel/thread maps to one OpenCode server process.
- Channel/thread to session mapping is persisted in `~/.opencodebot/sessions.json`.
- On process restart, bot tries to recover previous session by session ID.
- Slash commands: `/new`, `/compact`, `/sessions`, `/model`.
