/**
 * Kiro CLI provider — spawn config for kiro-cli ACP.
 */

import type { CliProvider } from "./types.js";

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
  };
}
