/**
 * OpenCode CLI provider — spawn config for opencode ACP.
 */

import type { CliProvider } from "./types.js";

export function opencodeProvider(): CliProvider {
  return {
    name: "opencode",
    bin: process.env.HIVE_OPENCODE_CLI_PATH || "opencode",
    args: ["acp"],
    capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  };
}
