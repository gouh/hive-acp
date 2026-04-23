/**
 * MCP WebSocket Handler — generic, receives tool categories from adapters.
 */

import type { WebSocket } from "ws";
import type { ToolCategory } from "./types.js";
import { log } from "../utils/logger.js";
import { pkg } from "../utils/pkg.js";

export function handleMcpConnection(ws: WebSocket, categories: ToolCategory[]): void {
  log.mcp.info("Client connected (%d categories: %s)", categories.length, categories.map((c) => c.name).join(", "));

  const allTools = categories.flatMap((c) => c.tools);
  const handlerMap = new Map<string, ToolCategory>();
  for (const cat of categories) {
    for (const tool of cat.tools) {
      handlerMap.set(tool.name, cat);
    }
  }

  ws.on("message", async (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const reply = await handle(msg, allTools, handlerMap);
    if (reply) ws.send(JSON.stringify(reply));
  });

  ws.on("close", () => log.mcp.info("Client disconnected"));
}

async function handle(
  msg: any,
  allTools: any[],
  handlerMap: Map<string, ToolCategory>,
): Promise<any | null> {
  if (msg.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: `${pkg.name}-mcp`, version: pkg.version },
      },
    };
  }

  if (msg.method === "notifications/initialized") return null;

  if (msg.method === "tools/list") {
    return { jsonrpc: "2.0", id: msg.id, result: { tools: allTools } };
  }

  if (msg.method === "tools/call") {
    const category = handlerMap.get(msg.params?.name);
    if (!category) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `Unknown tool: ${msg.params?.name}` }], isError: true },
      };
    }
    try {
      const text = await category.execute(msg.params.name, msg.params.arguments);
      return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } };
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
      };
    }
  }

  if (msg.id !== undefined) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unknown: ${msg.method}` } };
  }

  return null;
}
