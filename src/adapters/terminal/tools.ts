/**
 * Terminal tool category — MCP tool for executing shell commands with timeout and process group kill.
 */

import { spawn } from "node:child_process";
import type { ToolCategory } from "../../mcp/types.js";

export function createTerminalTools(workspace: string): ToolCategory {
  return {
    name: "terminal",
    tools: [
      {
        name: "terminal_execute",
        description:
          "Execute a shell command in the workspace. " +
          "Stdin is closed so interactive commands will fail. " +
          "Commands that don't finish within 15 seconds are killed. " +
          "For long-running processes (servers), use & to background them.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to execute" },
            timeout: { type: "number", description: "Timeout in ms (default 15000, max 30000)" },
          },
          required: ["command"],
        },
      },
    ],

    async execute(toolName: string, args: any): Promise<string> {
      if (toolName !== "terminal_execute") throw new Error(`Unknown tool: ${toolName}`);

      const timeoutMs = Math.min(args.timeout || 15_000, 30_000);

      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let killed = false;

        const child = spawn("sh", ["-c", args.command], {
          cwd: workspace,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });

        const timer = setTimeout(() => {
          killed = true;
          try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already dead */ }
          resolve(`${stdout}\n[timeout — process killed after ${timeoutMs / 1000}s]`);
        }, timeoutMs);

        child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

        child.on("close", (code) => {
          if (killed) return;
          clearTimeout(timer);
          const out = stdout + (stderr ? `\n${stderr}` : "");
          resolve(out || `[exit code ${code}]`);
        });

        child.on("error", (err) => {
          if (killed) return;
          clearTimeout(timer);
          resolve(`[error: ${err.message}]`);
        });
      });
    },
  };
}
