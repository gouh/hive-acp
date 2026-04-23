# hive-acp

ACP (Agent Client Protocol) bridge that connects AI agents to messaging platforms. Each conversation gets its own isolated agent process with persistent context.

Currently supports **Telegram** via [grammy](https://grammy.dev/), with an extensible adapter architecture for adding more connectors.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Telegram    │────▶│  TelegramAdapter │────▶│   AcpPool    │
│  (grammy)   │◀────│                  │     │              │
└─────────────┘     └──────────────────┘     │  ┌─────────┐ │
                                             │  │ Client 1│ │──▶ kiro-cli (stdio)
┌─────────────┐     ┌──────────────────┐     │  ├─────────┤ │
│  MCP Tools  │────▶│  WebSocket MCP   │     │  │ Client 2│ │──▶ kiro-cli (stdio)
│  (bridge)   │◀────│  Server          │     │  ├─────────┤ │
└─────────────┘     └──────────────────┘     │  │ Client N│ │──▶ kiro-cli (stdio)
                                             │  └─────────┘ │
                                             └──────────────┘
```

### Key components

| Component | Description |
|---|---|
| `AcpClient` | JSON-RPC 2.0 over stdio — communicates with a single kiro-cli process |
| `AcpPool` | Manages one `AcpClient` per chat with idle eviction, health checks, and context persistence |
| `MCP Server` | WebSocket server exposing tool categories to the AI agent via the bridge |
| `Adapters` | Chat platform connectors (Telegram) and utility tools (context management) |

## Features

- **Multi-agent** — each chat conversation spawns its own isolated kiro-cli process
- **Context persistence** — conversation summaries saved to disk on eviction, restored on reconnect
- **On-demand context management** — users can save, view, or clear context via chat commands
- **Health checks** — idle clients pinged every minute, dead processes auto-removed
- **Idle eviction** — unused agents cleaned up after 30 minutes with automatic summarization
- **Structured logging** — JSON logs with queryable fields (pino), ready for any observability stack
- **Extensible** — add new chat platforms or tool categories without touching core logic

## MCP Tools

### Telegram
| Tool | Description |
|---|---|
| `telegram_send_file` | Send a file from the workspace to the active chat |
| `telegram_react` | React to a message with an emoji |

### Context
| Tool | Description |
|---|---|
| `context_save` | Persist a conversation summary for the current chat |
| `context_show` | Display the saved summary |
| `context_clear` | Delete saved context and start fresh |

## Setup

### Prerequisites

- Node.js 20+
- [kiro-cli](https://github.com/aws/kiro-cli) installed and configured
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Installation

```bash
git clone git@github.com:gouh/hive-acp.git
cd hive-acp
npm install
```

### Configuration

```bash
cp .env.dist .env
```

Edit `.env` with your values:

| Variable | Required | Description |
|---|---|---|
| `HIVE_TELEGRAM_TOKEN` | ✅ | Token from [@BotFather](https://t.me/BotFather) |
| `HIVE_CLI_PATH` | | Absolute path to kiro-cli binary (default: `kiro-cli`) |
| `HIVE_WORKSPACE` | | Directory for the agent to operate in (default: `cwd`) |
| `HIVE_ALLOWED_USERS` | | Comma-separated Telegram user IDs |
| `HIVE_AGENT` | | Custom agent name matching `.kiro/agents/<name>.json` |
| `HIVE_MCP_PORT` | | WebSocket MCP server port (default: `4040`) |
| `HIVE_LOG_LEVEL` | | Pino log level (default: `info`) |

### Running

```bash
# Development (watch mode)
npm run dev

# Production
npm run build
npm start
```

## Project structure

```
src/
├── index.ts                          # Entry point and boot sequence
├── acp/
│   ├── client.ts                     # ACP JSON-RPC client (stdio to kiro-cli)
│   └── pool.ts                       # Client pool with eviction, health checks, context
├── adapters/
│   ├── chat/telegram/
│   │   ├── adapter.ts                # Telegram ↔ ACP message handling (grammy)
│   │   └── tools.ts                  # Telegram MCP tools (send_file, react)
│   └── context/
│       └── tools.ts                  # Context MCP tools (save, show, clear)
├── mcp/
│   ├── bridge.ts                     # stdio ↔ WebSocket bridge for kiro-cli
│   ├── handler.ts                    # MCP WebSocket protocol handler
│   └── types.ts                      # ToolCategory / ToolDefinition interfaces
└── utils/
    ├── env.ts                        # dotenv loader
    ├── logger.ts                     # Pino structured JSON logger
    └── pkg.ts                        # package.json reader
```

## Adding a new adapter

1. Create `src/adapters/chat/<platform>/adapter.ts` with your platform's SDK
2. Create `src/adapters/chat/<platform>/tools.ts` returning a `ToolCategory`
3. Register it in `src/index.ts` alongside the existing categories

The `ToolCategory` interface:

```typescript
interface ToolCategory {
  name: string;
  tools: ToolDefinition[];
  execute(toolName: string, args: any): Promise<string>;
}
```

## License

MIT
