# hive-acp

ACP (Agent Client Protocol) bridge that connects AI agents to messaging platforms.

Currently supports **Telegram** as a chat adapter, with an extensible architecture for adding more connectors (Slack, Discord, etc.).

## Architecture

```
Telegram ←→ TelegramAdapter ←→ AcpClient ←→ kiro-cli (stdio)
                                    ↕
                              MCP WebSocket Server
                              (tool categories)
```

- **ACP Client** — JSON-RPC 2.0 over stdio to communicate with kiro-cli
- **MCP Server** — WebSocket server exposing tools to the AI agent
- **Adapters** — Chat platform connectors (Telegram, more to come)

## Setup

```bash
# Install dependencies
npm install

# Copy env and configure
cp .env.example .env
# Edit .env with your Telegram bot token and settings

# Run in development
npm run dev

# Build and start
npm run build
npm start
```

## Configuration

See `.env.example` for all available options. Key settings:

- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
- `KIRO_CLI_PATH` — path to kiro-cli binary
- `KIRO_WORKSPACE` — directory for the agent to operate in
- `ALLOWED_USERS` — comma-separated Telegram user IDs

## License

MIT
