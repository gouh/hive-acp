/**
 * Hive ACP Telegram Bot — Entry Point
 *
 * Boot sequence:
 *   1. Load environment
 *   2. Create pool + adapter, register tool categories
 *   3. Start MCP WebSocket server (bridge endpoint)
 *   4. Start Telegram polling (ACP clients spawn on demand per chat)
 */

import "./utils/env.js";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { AcpPool } from "./acp/pool.js";
import { TelegramAdapter } from "./adapters/chat/telegram/adapter.js";
import { createTelegramTools } from "./adapters/chat/telegram/tools.js";
import { handleMcpConnection } from "./mcp/handler.js";
import type { ToolCategory } from "./mcp/types.js";
import { log } from "./utils/logger.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  log.main.fatal("TELEGRAM_BOT_TOKEN not set — copy .env.dist to .env");
  process.exit(1);
}

const MCP_PORT = parseInt(process.env.MCP_PORT || "4040", 10);
const WORKSPACE = process.env.KIRO_WORKSPACE || process.cwd();

async function boot(): Promise<void> {
  log.main.info("━━━ Hive ACP Telegram Bot ━━━");
  log.main.info("workspace: %s", WORKSPACE);

  // ── Step 1: Create core services ──────────────────────────
  log.main.info("[1/4] Creating services...");
  const pool = new AcpPool();
  const telegram = new TelegramAdapter(TOKEN!, pool);

  // ── Step 2: Register tool categories ──────────────────────
  log.main.info("[2/4] Registering tool categories...");
  const categories: ToolCategory[] = [
    createTelegramTools(telegram, WORKSPACE),
  ];
  for (const cat of categories) {
    log.mcp.info("  ├─ %s (%d tools: %s)", cat.name, cat.tools.length, cat.tools.map((t) => t.name).join(", "));
  }

  // ── Step 3: Start MCP WebSocket server ────────────────────
  log.main.info("[3/4] Starting MCP server...");
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/mcp") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleMcpConnection(ws, categories);
      });
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => server.listen(MCP_PORT, resolve));
  log.mcp.info("  └─ ws://localhost:%d/mcp", MCP_PORT);

  // ── Step 4: Start Telegram polling ────────────────────────
  log.main.info("[4/4] Starting Telegram adapter...");
  telegram.start();

  // ── Ready ─────────────────────────────────────────────────
  log.main.info("━━━ Ready — ACP clients spawn per chat on demand ━━━");

  const shutdown = () => {
    log.main.info("Shutting down...");
    telegram.stop();
    pool.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

boot().catch((err) => {
  log.main.fatal("Boot failed: %s", err);
  process.exit(1);
});
