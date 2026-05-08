/**
 * Kiro CLI provider — spawn config for kiro-cli ACP.
 */

import type { CliProvider } from "./types.js";

/** Extracts a clean, short tool name from Kiro's title format.
 *  "Running: @hive-acp/agent_job" → "agent_job"
 *  "Running: cd /Users/.../pomodoro && node server.js" → "node server.js"
 *  "Read file: config.ts" → "Read config.ts"
 */
function cleanToolTitle(raw: string): string {
  let t = raw.replace(/^Running:\s*/, "");
  if (t.startsWith("@")) {
    const slash = t.indexOf("/");
    if (slash !== -1) t = t.slice(slash + 1);
  }
  if (t.includes("&&")) t = t.split("&&").pop()!.trim();
  if (t.includes("\n")) t = t.split("\n")[0].trim();
  t = t.replace(/:\d+$/, "");
  if (t.length > 40) t = t.slice(0, 37) + "...";
  return t || raw;
}

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
    agentFlag: "--agent",
    cleanToolTitle,
    mapExtNotification(method, params) {
      if (method === "_kiro.dev/session/update") return params.update ?? null;
      return null;
    },
  };
}
