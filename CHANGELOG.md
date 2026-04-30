# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-30

### Added
- **ChatAdapter interface** — platform-agnostic abstraction for chat connectors (`sendResponse`, `sendPhoto`, `sendFile`, `bindJobManager`)
- **ProviderRegistry** — maps agent names to CLI providers, enabling multi-provider orchestration (Kiro + OpenCode in the same workflow)
- **Multi-agent orchestration** — `JobManager` dispatches tasks to subagents in parallel with real-time progress events
- **Orchestration MCP tools** — `agent_list`, `agent_dispatch`, `agent_job`, `agent_cancel`
- **Knowledge graph** — SPO triple store with JSON persistence (`memory_search`, `memory_add`, `memory_forget`)
- **Screenshot MCP tool** — `screenshot_url` via Puppeteer with configurable viewport, full-page capture, and delay
- **Image search MCP tool** — `images_search` via Pexels API with free stock photos
- **Terminal MCP tool** — `terminal_execute` for shell commands in the workspace
- **Agent creation CLI** — `npm run create-agent` interactive wizard for both Kiro (JSON) and OpenCode (Markdown) agents
- **Built-in skills** — auto-installed Telegram formatting skill
- **Centralized agent registry** — `~/.hive-acp/agents.json` as single source of truth for all agents
- **NdJsonParser module** — extracted newline-delimited JSON framing with unit tests
- **Adaptive streaming** — debounce 400ms→1200ms based on buffer size, auto-split at 3000 chars
- **Markdown normalization** — `toTelegramMd()` converts `**bold**` to `*bold*`, strips MarkdownV2 escapes
- **Subagent progress visibility** — tool progress shown per-line in chat, deleted on completion
- **Rich eviction snapshots** — saves summary + tool calls + files modified + estimated tokens
- **Context prefix injection** — knowledge graph + instructions prepended on session restore
- **HIVE_ORCHESTRATOR config** — select orchestrator agent by name instead of provider
- **Agent instructions for providers without CLI agent selection** — OpenCode agents get instructions prepended to task prompts
- **Client recycling** — dead/timed-out clients automatically killed and recreated on next message
- **Hive management scripts** — `hive:start`, `hive:stop`, `hive:status`, `hive:logs`, `hive:restart`

### Changed
- **TelegramAdapter** implements `ChatAdapter` interface — all tools use the abstraction
- **AcpPool** receives `ProviderRegistry` + orchestrator name instead of a single provider
- **JobManager** resolves provider per agent from registry — mixed Kiro/OpenCode subagents in one job
- **JobEvent** includes `parser` from the subagent's provider for correct notification parsing
- **Streaming flush** always executes on `final=true` regardless of content equality
- **Tool progress format** — one tool per line instead of arrow-joined single line
- **`index.ts`** reduced from 170 to ~150 lines — job event logic moved to `TelegramAdapter.bindJobManager()`
- **`telegram/tools.ts`** — `send_file` uses `ChatAdapter.sendPhoto/sendFile`, only `react` accesses bot directly
- **Parsers** — underscore escaping moved from ACP parsers to Telegram presentation layer
- **OpenCode turn detection** — `fullMessage` triggers `turn_message` event for providers without `TurnEnd`
- **All user-facing strings** in English

### Fixed
- **Messages not delivered** — streaming buffer flushed but `streamMsgId` null after turn reset; now falls back to `sendResponse`
- **Race condition in `onTurn`** — now async, awaits flush before resetting state
- **Markdown not rendered** — streaming sent without `parse_mode`; final edit now applies Markdown with plain-text fallback
- **Tool names breaking Markdown** — underscores in names like `telegram_react` escaped in presentation layer
- **"Message not modified" errors** — benign Telegram API errors now silently ignored
- **`activeCtx` cleared too early** — context persists per chat so tools work during `drainToAgent`

## [0.0.1] - 2026-04-22

### Added
- Initial ACP bridge with Telegram adapter (grammy)
- ACP JSON-RPC 2.0 client over stdio
- Multi-agent pool — one `AcpClient` per chat conversation
- Context persistence — summarize on eviction, restore on reconnect
- Health check ping with auto-removal of dead clients
- Context management MCP tools (`context_save`, `context_show`, `context_clear`)
- Telegram MCP tools (`telegram_send_file`, `telegram_react`)
- MCP WebSocket server with stdio bridge
- Structured JSON logging (pino)
- CLI provider abstraction (Kiro + OpenCode)
- Environment configuration via `.env` with `HIVE_*` prefix
