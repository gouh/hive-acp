/**
 * Hive ACP — Entry Point
 *
 * Boot sequence:
 *   1. Load environment
 *   2. Build provider registry and discover agents
 *   3. Create pool + chat adapter, register tool categories
 *   4. Start MCP WebSocket server (bridge endpoint)
 *   5. Start chat adapter (ACP clients spawn on demand per chat)
 */

import "./utils/env.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { AcpPool } from "./acp/pool.js";
import { ProviderRegistry } from "./acp/registry.js";
import { kiroProvider } from "./acp/providers/kiro.js";
import { opencodeProvider } from "./acp/providers/opencode.js";
import { TelegramAdapter } from "./adapters/chat/telegram/adapter.js";
import { createTelegramTools } from "./adapters/chat/telegram/tools.js";
import { createContextTools } from "./adapters/context/tools.js";
import { createImageTools } from "./adapters/images/tools.js";
import { createScreenshotTools } from "./adapters/screenshot/tools.js";
import { createTerminalTools } from "./adapters/terminal/tools.js";
import { TripleStore } from "./memory/store.js";
import { createMemoryTools } from "./memory/tools.js";
import { handleMcpConnection } from "./mcp/handler.js";
import type { ToolCategory } from "./mcp/types.js";
import { JobManager } from "./orchestration/job-manager.js";
import { createOrchestrationTools } from "./orchestration/tools.js";
import { log } from "./utils/logger.js";
import { bootstrap, HIVE_HOME } from "./utils/paths.js";
import { pkg } from "./utils/pkg.js";

const TOKEN = process.env.HIVE_TELEGRAM_TOKEN;
if (!TOKEN) {
  log.main.fatal("HIVE_TELEGRAM_TOKEN not set");
  process.exit(1);
}

const MCP_PORT = parseInt(process.env.HIVE_MCP_PORT || "4040", 10);
const WORKSPACE = process.env.HIVE_WORKSPACE || process.cwd();

/** Build the provider registry: register providers and discover agents. */
function buildRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();

  // Register available providers
  registry.addProvider("kiro", kiroProvider());
  registry.addProvider("opencode", opencodeProvider());

  // Load all agents from ~/.hive-acp/agents.json (single source of truth)
  const agentsFile = path.join(HIVE_HOME, "agents.json");
  if (fs.existsSync(agentsFile)) {
    try {
      const agents = JSON.parse(fs.readFileSync(agentsFile, "utf-8")) as Array<{
        name: string;
        provider: string;
        description?: string;
      }>;
      for (const a of agents) {
        // For providers without agentFlag, load instructions from the agent file
        let instructions: string | undefined;
        if (a.provider === "opencode") {
          const mdPath = path.join(os.homedir(), ".config", "opencode", "agents", `${a.name}.md`);
          if (fs.existsSync(mdPath)) {
            const raw = fs.readFileSync(mdPath, "utf-8");
            // Strip YAML frontmatter, keep only the prompt body
            instructions = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
          }
        }
        registry.addAgent(a.name, a.provider, a.description || "", instructions);
      }
    } catch (err: any) {
      log.main.warn({ err: err.message }, "failed to load agents.json");
    }
  }

  const agents = registry.listAgents();
  log.main.info({ agents: agents.map((a) => `${a.name}(${a.provider})`) }, "registry built");
  return registry;
}

async function boot(): Promise<void> {
  bootstrap();

  const registry = buildRegistry();

  // Resolve the orchestrator agent and its provider
  const orchestrator = process.env.HIVE_ORCHESTRATOR || "hiveacp-orchestrator";
  const mainProvider = registry.resolve(orchestrator);
  if (!mainProvider) {
    log.main.fatal({ orchestrator }, "orchestrator agent not found in registry");
    process.exit(1);
  }

  log.main.info({ version: pkg.version, workspace: WORKSPACE, home: HIVE_HOME, orchestrator, provider: mainProvider.name }, "starting");

  const store = new TripleStore();
  const pool = new AcpPool(registry, store, orchestrator);
  const chat = new TelegramAdapter(TOKEN!, pool);
  const jobManager = new JobManager(registry, store);

  chat.bindJobManager(jobManager, pool);

  const categories: ToolCategory[] = [
    createTelegramTools(chat, WORKSPACE),
    createContextTools(pool, chat),
    createMemoryTools(store),
    createOrchestrationTools(jobManager, registry),
    createTerminalTools(WORKSPACE),
    createScreenshotTools(chat),
    createImageTools(chat),
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

  chat.start();
  log.main.info("ready");

  const shutdown = async () => {
    log.main.info("shutting down");
    chat.stop();
    await jobManager.stop();
    await pool.stop();
    store.flush();
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
