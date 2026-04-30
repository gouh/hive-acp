/**
 * ACP Client — JSON-RPC 2.0 over stdio.
 *
 * Implements the Agent Client Protocol (ACP) to communicate with any
 * ACP-compatible CLI agent. Provider-specific notification parsing is
 * delegated to the CliProvider's ResponseParser.
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/logger.js";
import { pkg } from "../utils/pkg.js";
import { NdJsonParser } from "./framing.js";
import type { CliProvider } from "./providers/types.js";

const WORKSPACE = process.env.HIVE_WORKSPACE || process.cwd();

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string };
}

export class AcpClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private sessionId: string | null = null;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private parser = new NdJsonParser(
    (msg) => this.handleMessage(msg as JsonRpcMessage),
    (err) => log.acp.warn("Failed to parse message: %s", err.message),
  );
  private promptLock: Promise<void> = Promise.resolve();

  /** Context usage metrics — tracked across the lifetime of this client. */
  readonly metrics = {
    promptCount: 0,
    chunkCount: 0,
    charCount: 0,
    toolCalls: [] as string[],
    filesModified: [] as string[],
    startedAt: Date.now(),
  };

  /** Rough token estimate (~4 chars per token). */
  get estimatedTokens(): number {
    return Math.ceil(this.metrics.charCount / 4);
  }

  constructor(private provider: CliProvider, private agentOverride?: string) {
    super();
  }

  async start(): Promise<string | null> {
    const flag = this.provider.agentFlag;
    const args = this.agentOverride && flag
      ? [...this.provider.args.filter((a, i, arr) => a !== flag && arr[i - 1] !== flag), flag, this.agentOverride]
      : this.provider.args;

    log.acp.info({ provider: this.provider.name, bin: this.provider.bin, agent: this.agentOverride, cwd: WORKSPACE }, "spawning agent");

    this.proc = spawn(this.provider.bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.provider.env },
      cwd: WORKSPACE,
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => this.parser.write(chunk));
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) log.acp.debug(msg);
    });
    this.proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        log.acp.error(`agent exited (code ${code})`);
      } else {
        log.acp.debug(`agent exited (code ${code})`);
      }
      for (const [, { reject, timeout }] of this.pending) {
        clearTimeout(timeout);
        reject(new Error(`agent exited unexpectedly (code ${code})`));
      }
      this.pending.clear();
      this.emit("exit", code);
    });

    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: this.provider.capabilities,
      clientInfo: { name: pkg.name, version: pkg.version },
    });
    log.acp.info({ server: init.agentInfo?.name, serverVersion: init.agentInfo?.version }, "initialized");

    const session = await this.request("session/new", {
      cwd: WORKSPACE,
      mcpServers: [],
    });
    this.sessionId = session.sessionId;
    log.acp.info({ sessionId: this.sessionId }, "session created");

    return this.sessionId;
  }

  prompt(content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>): Promise<string> {
    const { parser } = this.provider;

    const run = (): Promise<string> => new Promise((resolve, reject) => {
      let chunks: string[] = [];
      let fullMessage: string | null = null;
      this.metrics.promptCount++;

      const onNotification = (_method: string, params: any) => {
        const u = params.update;
        if (!u) return;

        log.acp.debug({ sessionUpdate: u.sessionUpdate }, "session update received");

        // Track tool calls
        const tool = parser.toolCall(u);
        if (tool) this.metrics.toolCalls.push(tool);

        // Turn boundary — emit the completed turn's text and reset for the next turn.
        if (parser.isTurnEnd(u)) {
          const text = fullMessage ?? chunks.join("");
          if (text) this.emit("turn_message", text);
          chunks = [];
          fullMessage = null;
          return;
        }

        const chunk = parser.messageChunk(u);
        if (chunk !== null) {
          chunks.push(chunk);
          this.metrics.chunkCount++;
          this.metrics.charCount += chunk.length;
        }

        const full = parser.fullMessage(u);
        if (full !== null) {
          fullMessage = full;
        }
      };

      this.on("notification", onNotification);

      this.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: content,
      })
        .then(() => {
          this.removeListener("notification", onNotification);
          resolve(fullMessage ?? chunks.join(""));
        })
        .catch((err) => {
          this.removeListener("notification", onNotification);
          reject(err);
        });
    });

    // Serialize prompts — wait for previous to finish before starting next
    const result = this.promptLock.then(() => run());
    this.promptLock = result.then(() => {}, () => {});
    return result;
  }

  async summarize(): Promise<string> {
    try {
      return await this.prompt([{
        type: "text",
        text: "Generate a concise summary of our conversation so far. Include key topics discussed, decisions made, and any pending tasks. This summary will be used to restore context in a future session. Respond ONLY with the summary, no preamble.",
      }]);
    } catch (err: any) {
      log.acp.warn("Failed to generate summary: %s", err.message);
      return "";
    }
  }

  async extractTriples(): Promise<Array<{ s: string; p: string; o: string }>> {
    try {
      const raw = await this.prompt([{
        type: "text",
        text: "Extract key facts from our conversation as subject|predicate|object triples. One per line. Only concrete facts. Max 10.\nExample: Defensa|uses|PostgreSQL\n\nRespond ONLY with the triples, no preamble.",
      }]);
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("|"))
        .map((line) => {
          const [s, p, o] = line.split("|").map((x) => x.trim());
          return s && p && o ? { s, p, o } : null;
        })
        .filter((t): t is { s: string; p: string; o: string } => t !== null);
    } catch (err: any) {
      log.acp.warn("Failed to extract triples: %s", err.message);
      return [];
    }
  }

  async ping(): Promise<boolean> {
    try {
      if (!this.proc?.stdin?.writable) return false;
      // Bypass promptLock — ping is a lightweight health check that should not
      // queue behind long-running prompts or block them.
      await this.request("ping", {});
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  private request(method: string, params: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const ms = method === "session/prompt" ? 600_000 : method === "ping" ? 10_000 : 120_000;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, ms);
      this.pending.set(id, { resolve, reject, timeout });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(msg: JsonRpcMessage): void {
    if (!this.proc?.stdin?.writable) throw new Error("ACP process not running");
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timeout } = this.pending.get(msg.id)!;
      clearTimeout(timeout);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      this.handleServerRequest(msg);
      return;
    }
    if (msg.method) {
      this.emit("notification", msg.method, msg.params || {});
    }
  }

  private async handleServerRequest(msg: JsonRpcMessage): Promise<void> {
    try {
      const result = await this.dispatch(msg.method!, msg.params || {});
      this.send({ jsonrpc: "2.0", id: msg.id, result } as any);
    } catch (err: any) {
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: err.message },
      });
    }
  }

  private async dispatch(method: string, params: Record<string, any>): Promise<any> {
    switch (method) {
      case "fs/readTextFile": {
        const p = params.path.startsWith("/")
          ? params.path
          : path.join(WORKSPACE, params.path);
        return { content: fs.readFileSync(p, "utf-8") };
      }
      case "fs/writeTextFile": {
        const p = params.path.startsWith("/")
          ? params.path
          : path.join(WORKSPACE, params.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, params.content, "utf-8");
        this.metrics.filesModified.push(p);
        return { success: true };
      }
      case "terminal/execute": {
        return new Promise((resolve) => {
          let stdout = "";
          let stderr = "";
          let killed = false;

          const child = spawn("sh", ["-c", params.command], {
            cwd: WORKSPACE,
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
          });

          const timer = setTimeout(() => {
            killed = true;
            try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already dead */ }
            resolve({ output: `${stdout}\n[timeout — process killed after 15s]` });
          }, 15_000);

          child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
          child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

          child.on("close", (code) => {
            if (killed) return;
            clearTimeout(timer);
            const out = stdout + (stderr ? `\n${stderr}` : "");
            resolve({ output: out || `[exit code ${code}]` });
          });

          child.on("error", (err) => {
            if (killed) return;
            clearTimeout(timer);
            resolve({ output: `[error: ${err.message}]` });
          });
        });
      }
      default:
        throw new Error(`Unsupported: ${method}`);
    }
  }
}
