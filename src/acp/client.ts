/**
 * ACP Client — powered by @agentclientprotocol/sdk.
 *
 * Uses SDK types directly for session updates. No custom ResponseParser needed.
 * Emits typed events for the adapter to consume.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { log } from "../utils/logger.js";
import { pkg } from "../utils/pkg.js";
import type { CliProvider } from "./providers/types.js";

const WORKSPACE = process.env.HIVE_WORKSPACE || process.cwd();

/** Typed events emitted by AcpClient. */
export interface AcpEvents {
  /** A text chunk from the agent's response. */
  chunk: (text: string) => void;
  /** A tool call started. */
  tool: (name: string, toolCallId: string) => void;
  /** A tool call status changed. */
  tool_update: (toolCallId: string, status: string) => void;
  /** A turn completed — full text of the turn. */
  turn_end: (text: string) => void;
  /** The agent process exited. */
  exit: (code: number | null) => void;
}

export class AcpClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private promptLock: Promise<void> = Promise.resolve();

  readonly metrics = {
    promptCount: 0,
    chunkCount: 0,
    charCount: 0,
    toolCalls: [] as string[],
    filesModified: [] as string[],
    startedAt: Date.now(),
  };

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

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) log.acp.debug(msg);
    });
    this.proc.on("exit", (code) => {
      if (code !== null && code !== 0) log.acp.error(`agent exited (code ${code})`);
      this.emit("exit", code);
    });

    const input = Writable.toWeb(this.proc.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(this.proc.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    this.conn = new acp.ClientSideConnection(
      (_agent) => this.createClientHandler(),
      stream,
    );

    const init = await this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: this.provider.capabilities,
      clientInfo: { name: pkg.name, version: pkg.version },
    });
    log.acp.info({ server: init.agentInfo?.name, serverVersion: init.agentInfo?.version }, "initialized");

    const session = await this.conn.newSession({ cwd: WORKSPACE, mcpServers: [] });
    this.sessionId = session.sessionId;
    log.acp.info({ sessionId: this.sessionId }, "session created");

    return this.sessionId;
  }

  prompt(content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>): Promise<string> {
    if (!this.conn || !this.sessionId) return Promise.reject(new Error("ACP client not started"));

    const run = async (): Promise<string> => {
      this.metrics.promptCount++;
      this._chunks = [];
      this._fullMessage = null;

      await this.conn!.prompt({ sessionId: this.sessionId!, prompt: content as any });

      return this._fullMessage ?? this._chunks.join("");
    };

    const result = this.promptLock.then(() => run());
    this.promptLock = result.then(() => {}, () => {});
    return result;
  }

  private _chunks: string[] = [];
  private _fullMessage: string | null = null;

  private createClientHandler(): acp.Client {
    const self = this;
    const cleanTitle = this.provider.cleanToolTitle ?? ((t: string) => t);

    return {
      async sessionUpdate(params: acp.SessionNotification): Promise<void> {
        const update = params.update as acp.SessionUpdate;
        if (!update) return;

        log.acp.debug({ sessionUpdate: update.sessionUpdate }, "session update received");

        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            const text = (update.content as any)?.text;
            if (text) {
              self._chunks.push(text);
              self.metrics.chunkCount++;
              self.metrics.charCount += text.length;
              self.emit("chunk", text);
            }
            break;
          }

          case "tool_call": {
            const name = cleanTitle(update.title || "tool");
            self.metrics.toolCalls.push(name);
            self.emit("tool", name, update.toolCallId);
            break;
          }

          case "tool_call_update": {
            const status = update.status ?? "";
            self.emit("tool_update", update.toolCallId, status);
            break;
          }

          // agent_message = full message (some providers send this instead of/after chunks)
          // We treat it as the authoritative full text for the turn.
          default: {
            const u = update as any;
            if (u.sessionUpdate === "agent_message" && u.content?.text) {
              self._fullMessage = u.content.text;
            }
            // TurnEnd (Kiro) — emit turn boundary
            if (u.sessionUpdate === "TurnEnd" || u.sessionUpdate === "turn_end") {
              const text = self._fullMessage ?? self._chunks.join("");
              if (text) self.emit("turn_end", text);
              self._chunks = [];
              self._fullMessage = null;
            }
            break;
          }
        }
      },

      async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
        const opt = params.options.find((o) => o.kind === "allow_always")
          || params.options.find((o) => o.kind === "allow_once")
          || params.options[0];
        return { outcome: { outcome: "selected", optionId: opt.optionId } };
      },

      async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
        const p = params.path.startsWith("/") ? params.path : path.join(WORKSPACE, params.path);
        return { content: fs.readFileSync(p, "utf-8") };
      },

      async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
        const p = params.path.startsWith("/") ? params.path : path.join(WORKSPACE, params.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, params.content, "utf-8");
        self.metrics.filesModified.push(p);
        return {};
      },

      async createTerminal(_params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
        return { terminalId: `term-${Date.now()}` };
      },

      async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
        const mapped = self.provider.mapExtNotification?.(method, params as any);
        if (mapped) {
          await this.sessionUpdate({ sessionId: (params as any).sessionId, update: mapped } as any);
          return;
        }
        log.acp.debug({ method }, "ignored extension notification");
      },
    };
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
        text: "Extract key facts from our conversation as subject|predicate|object triples. One per line. Only concrete facts. Max 10.\nExample: ProjectX|uses|PostgreSQL\n\nRespond ONLY with the triples, no preamble.",
      }]);
      return raw.split("\n")
        .map((l) => l.trim()).filter((l) => l.includes("|"))
        .map((l) => { const [s, p, o] = l.split("|").map((x) => x.trim()); return s && p && o ? { s, p, o } : null; })
        .filter((t): t is { s: string; p: string; o: string } => t !== null);
    } catch (err: any) {
      log.acp.warn("Failed to extract triples: %s", err.message);
      return [];
    }
  }

  async ping(): Promise<boolean> {
    try {
      return this.proc?.exitCode === null && !!this.proc?.stdin?.writable;
    } catch { return false; }
  }

  stop(): void {
    if (this.proc) { this.proc.kill(); this.proc = null; }
    this.conn = null;
  }
}
