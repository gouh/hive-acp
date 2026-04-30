/**
 * Kiro CLI provider — spawn config for kiro-cli ACP.
 *
 * Kiro uses PascalCase session updates (TurnEnd, AgentMessageChunk)
 * but also sends snake_case variants. The parser handles both.
 */

import type { CliProvider, ResponseParser } from "./types.js";

/** Extracts a clean, short tool name from Kiro's title format.
 *  "Running: @hive-acp/agent_job" → "agent_job"
 *  "Running: cd /Users/.../pomodoro && node server.js" → "node server.js"
 *  "Read file: config.ts" → "Read config.ts"
 *  "Reading index.html:1" → "Reading index.html"
 */
function cleanToolTitle(raw: string): string {
  let t = raw.replace(/^Running:\s*/, "");
  // MCP tool: @scope/tool_name → tool_name
  if (t.startsWith("@")) {
    const slash = t.indexOf("/");
    if (slash !== -1) t = t.slice(slash + 1);
  }
  // Shell command: take last command in a chain, truncate
  if (t.includes("&&")) t = t.split("&&").pop()!.trim();
  if (t.includes("\n")) t = t.split("\n")[0].trim();
  // Remove line numbers like ":1"
  t = t.replace(/:\d+$/, "");
  // Truncate long strings
  if (t.length > 40) t = t.slice(0, 37) + "...";
  return t || raw;
}

const kiroParser: ResponseParser = {
  messageChunk(u) {
    if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "AgentMessageChunk") {
      return u.content?.text ?? null;
    }
    return null;
  },
  fullMessage(u) {
    if (u.sessionUpdate === "agent_message" || u.sessionUpdate === "AgentMessage") {
      return u.content?.text ?? null;
    }
    return null;
  },
  isTurnEnd(u) {
    return u.sessionUpdate === "TurnEnd" || u.sessionUpdate === "turn_end";
  },
  toolCall(u) {
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "ToolCall") {
      return cleanToolTitle(u.title || u.toolName || "tool");
    }
    return null;
  },
  toolCallUpdate(u) {
    if (u.sessionUpdate === "tool_call_update" || u.sessionUpdate === "ToolCallUpdate") {
      return { toolCallId: u.toolCallId, status: u.status || "", title: u.title };
    }
    return null;
  },
  isToolCallChunk(u) {
    return u.sessionUpdate === "tool_call_chunk" || u.sessionUpdate === "ToolCallChunk";
  },
};

export function kiroProvider(): CliProvider {
  const args = ["acp", "--trust-all-tools"];
  const agent = process.env.HIVE_KIRO_AGENT;
  if (agent) args.push("--agent", agent);

  return {
    name: "kiro",
    bin: process.env.HIVE_KIRO_CLI_PATH || "kiro-cli",
    args,
    env: { KIRO_LOG_LEVEL: "error" },
    capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    parser: kiroParser,
    agentFlag: "--agent",
  };
}
