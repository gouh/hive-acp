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
import { createContextTools } from "./adapters/context/tools.js";
import { handleMcpConnection } from "./mcp/handler.js";
import type { ToolCategory } from "./mcp/types.js";
import { log } from "./utils/logger.js";
import { pkg } from "./utils/pkg.js";

const TOKEN = process.env.HIVE_TELEGRAM_TOKEN;
if (!TOKEN) {
  log.main.fatal("HIVE_TELEGRAM_TOKEN not set");
  process.exit(1);
}

const MCP_PORT = parseInt(process.env.HIVE_MCP_PORT || "4040", 10);
const WORKSPACE = process.env.HIVE_WORKSPACE || process.cwd();

async function boot(): Promise<void> {
  log.main.info({ version: pkg.version, workspace: WORKSPACE }, "starting");

  const pool = new AcpPool();
  const telegram = new TelegramAdapter(TOKEN!, pool);

  const categories: ToolCategory[] = [
    createTelegramTools(telegram, WORKSPACE),
    createContextTools(pool, telegram),
  ];
  for (const cat of categories) {
    log.mcp.info({ category: cat.name, tools: cat.tools.map((t) => t.name) }, "tools registered");
  }

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
  log.mcp.info({ port: MCP_PORT, path: "/mcp" }, "server listening");

  telegram.start();
  log.main.info("ready");

  const shutdown = async () => {
    log.main.info("shutting down");
    telegram.stop();
    await pool.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
}

boot().catch((err) => {
  log.main.fatal({ err }, "boot failed");
  process.exit(1);
});
