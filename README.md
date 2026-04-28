# hive-acp

An open source alternative to [OpenClaw](https://github.com/nicepkg/openclaw) focused on development workflows. Bridge that connects AI agents to messaging platforms using [ACP](https://agentclientprotocol.com) and [MCP](https://modelcontextprotocol.io), with isolated agent processes per conversation and persistent context.

Currently supports **Telegram** via [grammy](https://grammy.dev/), with an extensible adapter architecture for adding more connectors.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Telegram    │────▶│  TelegramAdapter │────▶│   AcpPool    │
│  (grammy)   │◀────│                  │     │              │
└─────────────┘     └──────────────────┘     │  ┌─────────┐ │
                                             │  │ Agent 1 │ │──▶ ACP (stdio)
┌─────────────┐     ┌──────────────────┐     │  ├─────────┤ │
│  MCP Tools  │────▶│  WebSocket MCP   │     │  │ Agent 2 │ │──▶ ACP (stdio)
│  (bridge)   │◀────│  Server          │     │  ├─────────┤ │
└─────────────┘     └──────────────────┘     │  │ Agent N │ │──▶ ACP (stdio)
                                             │  └─────────┘ │
                                             └──────────────┘
```

### Key components

| Component | Description |
|---|---|
| `AcpClient` | JSON-RPC 2.0 over stdio — communicates with a single agent process |
| `AcpPool` | Manages one `AcpClient` per chat with idle eviction, health checks, and context persistence |
| `MCP Server` | WebSocket server exposing tool categories to the agent via the bridge |
| `Adapters` | Chat platform connectors (Telegram) and utility tools (context management) |

## Features

- **Multi-agent** — each chat conversation spawns its own isolated agent process
- **Context persistence** — conversation summaries saved to disk on eviction, restored on reconnect
- **On-demand context management** — users can save, view, or clear context via natural language
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
- An ACP-compatible CLI agent installed and configured
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

#### General

| Variable | Required | Description |
|---|---|---|
| `HIVE_WORKSPACE` | | Directory for the agent to operate in (default: `cwd`) |
| `HIVE_MCP_PORT` | | WebSocket MCP server port (default: `4040`) |
| `HIVE_LOG_LEVEL` | | Pino log level (default: `info`) |

#### Provider

| Variable | Required | Description |
|---|---|---|
| `HIVE_PROVIDER` | | ACP CLI provider to use: `kiro`, `opencode` (default: `kiro`) |

#### Kiro

| Variable | Required | Description |
|---|---|---|
| `HIVE_KIRO_CLI_PATH` | | Absolute path to `kiro-cli` binary (default: `kiro-cli` in PATH) |
| `HIVE_KIRO_AGENT` | | Agent name matching `<workspace>/.kiro/agents/<name>.json` |

#### OpenCode

| Variable | Required | Description |
|---|---|---|
| `HIVE_OPENCODE_CLI_PATH` | | Absolute path to `opencode` binary (default: `opencode` in PATH) |

> OpenCode also needs its provider API key (e.g. `ANTHROPIC_API_KEY`) set in your environment or configured in `opencode.json`. See [OpenCode docs](https://opencode.ai/docs/config/) for details.

#### Telegram

| Variable | Required | Description |
|---|---|---|
| `HIVE_TELEGRAM_TOKEN` | ✅ | Token from [@BotFather](https://t.me/BotFather) |
| `HIVE_ALLOWED_USERS` | | Comma-separated Telegram user IDs |

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
│   ├── client.ts                     # ACP JSON-RPC client (stdio)
│   ├── pool.ts                       # Client pool with eviction, health checks, context
│   └── providers/
│       ├── types.ts                  # CliProvider interface
│       ├── kiro.ts                   # Kiro CLI provider
│       └── opencode.ts              # OpenCode CLI provider
├── adapters/
│   ├── chat/telegram/
│   │   ├── adapter.ts                # Telegram - ACP message handling (grammy)
│   │   └── tools.ts                  # Telegram MCP tools (send_file, react)
│   └── context/
│       └── tools.ts                  # Context MCP tools (save, show, clear)
├── mcp/
│   ├── bridge.ts                     # stdio - WebSocket bridge
│   ├── handler.ts                    # MCP WebSocket protocol handler
│   └── types.ts                      # ToolCategory / ToolDefinition interfaces
└── utils/
    ├── env.ts                        # dotenv loader
    ├── logger.ts                     # Pino structured JSON logger
    └── pkg.ts                        # package.json reader
```

## Adding a new provider

1. Create `src/acp/providers/<name>.ts` returning a `CliProvider`
2. Add the case to the provider switch in `src/index.ts`
3. Add `HIVE_<NAME>_*` variables to `.env.dist`

The `CliProvider` interface:

```typescript
interface CliProvider {
  name: string;
  bin: string;
  args: string[];
  env?: Record<string, string>;
  capabilities: Record<string, any>;
}
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
