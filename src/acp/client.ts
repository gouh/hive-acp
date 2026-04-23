/**
 * ACP Client — JSON-RPC 2.0 over stdio to Kiro CLI
 *
 * Implements the Agent Client Protocol (ACP) to communicate with Kiro CLI.
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/logger.js";

const KIRO_CLI = process.env.KIRO_CLI_PATH || "kiro-cli";
const WORKSPACE = process.env.KIRO_WORKSPACE || process.cwd();

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
  private buffer = "";
  private promptLock: Promise<void> = Promise.resolve();

  async start(): Promise<string | null> {
    const args = ["acp", "--trust-all-tools"];
    const agent = process.env.KIRO_AGENT;
    if (agent) args.push("--agent", agent);
    log.acp.info("  ├─ bin: %s", KIRO_CLI);
    log.acp.info("  ├─ agent: %s", agent || "default");
    log.acp.info("  └─ cwd: %s", WORKSPACE);

    this.proc = spawn(KIRO_CLI, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, KIRO_LOG_LEVEL: "error" },
      cwd: WORKSPACE,
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) log.acp.debug(msg);
    });
    this.proc.on("exit", (code) => {
      log.acp.error(`kiro-cli exited (code ${code})`);
      for (const [, { reject, timeout }] of this.pending) {
        clearTimeout(timeout);
        reject(new Error(`kiro-cli exited unexpectedly (code ${code})`));
      }
      this.pending.clear();
      this.emit("exit", code);
    });

    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "kiro-acp-telegram-bot", version: "1.0.0" },
    });
    log.acp.info("  ├─ server: %s %s", init.agentInfo?.name, init.agentInfo?.version);

    const session = await this.request("session/new", {
      cwd: WORKSPACE,
      mcpServers: [],
    });
    this.sessionId = session.sessionId;
    log.acp.info("  └─ session: %s", this.sessionId);

    return this.sessionId;
  }

  prompt(content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>): Promise<string> {
    let release: () => void;
    const next = new Promise<void>((r) => (release = r));
    const wait = this.promptLock;
    this.promptLock = next;

    return wait.then(() => new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];

      const onNotification = (_method: string, params: any) => {
        const u = params.update;
        if (u?.sessionUpdate === "agent_message_chunk" && u.content?.text) {
          chunks.push(u.content.text);
        }
      };

      this.on("notification", onNotification);

      this.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: content,
      })
        .then(() => {
          this.removeListener("notification", onNotification);
          release!();
          resolve(chunks.join(""));
        })
        .catch((err) => {
          this.removeListener("notification", onNotification);
          release!();
          reject(err);
        });
    }));
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
      const ms = method === "session/prompt" ? 300_000 : 120_000;
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

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (err: any) {
        log.acp.warn("Failed to parse message: %s", err.message);
      }
    }
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
        return { success: true };
      }
      case "terminal/execute": {
        const out = execSync(params.command, {
          cwd: WORKSPACE,
          timeout: 30_000,
          encoding: "utf-8",
        });
        return { output: out };
      }
      default:
        throw new Error(`Unsupported: ${method}`);
    }
  }
}
