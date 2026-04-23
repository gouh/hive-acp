#!/usr/bin/env node
/**
 * MCP stdio bridge — connects kiro-cli (stdio) to the bot's WebSocket MCP server.
 */

import WebSocket from "ws";

const MCP_URL = process.env.MCP_URL || "ws://localhost:4040/mcp";

// Buffer stdin immediately so we don't lose messages before WS connects
const pendingMessages: string[] = [];
let wsReady = false;
let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    if (wsReady) {
      ws.send(line);
    } else {
      pendingMessages.push(line);
    }
  }
});

const ws = new WebSocket(MCP_URL);

ws.on("open", () => {
  wsReady = true;
  process.stderr.write(`[bridge] connected to ${MCP_URL}\n`);
  for (const msg of pendingMessages) {
    ws.send(msg);
  }
  pendingMessages.length = 0;
});

ws.on("message", (data) => {
  process.stdout.write(data.toString() + "\n");
});

ws.on("error", (err) => {
  process.stderr.write(`[bridge] error: ${err.message}\n`);
  process.exit(1);
});

ws.on("close", () => {
  process.stderr.write("[bridge] disconnected\n");
  process.exit(0);
});
