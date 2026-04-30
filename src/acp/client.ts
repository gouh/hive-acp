/**
 * ACP Client — powered by @agentclientprotocol/sdk.
 *
 * Wraps ClientSideConnection to provide a simplified API for hive-acp.
 * Provider-specific notification parsing is delegated to the CliProvider's ResponseParser.
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

export class AcpClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
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

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) log.acp.debug(msg);
    });
    this.proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        log.acp.error(`agent exited (code ${code})`);
      }
      this.emit("exit", code);
    });

    // Create SDK connection
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

    const session = await this.conn.newSession({
      cwd: WORKSPACE,
      mcpServers: [],
    });
    this.sessionId = session.sessionId;
    log.acp.info({ sessionId: this.sessionId }, "session created");

    return this.sessionId;
  }

  prompt(content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>): Promise<string> {
    if (!this.conn || !this.sessionId) {
      return Promise.reject(new Error("ACP client not started"));
    }

    const run = async (): Promise<string> => {
      this.metrics.promptCount++;
      this._promptChunks = [];
      this._promptFullMessage = null;

      await this.conn!.prompt({
        sessionId: this.sessionId!,
        prompt: content as any,
      });

      // prompt() resolves after all sessionUpdate callbacks have been called.
      return this._promptFullMessage ?? this._promptChunks.join("");
    };

    const result = this.promptLock.then(() => run());
    this.promptLock = result.then(() => {}, () => {});
    return result;
  }

  // Accumulator for the current prompt's text
  private _promptChunks: string[] = [];
  private _promptFullMessage: string | null = null;

  private createClientHandler(): acp.Client {
    const self = this;
    const { parser } = this.provider;

    return {
      async sessionUpdate(params: acp.SessionNotification): Promise<void> {
        const u = params.update as Record<string, any>;
        if (!u) return;

        log.acp.debug({ sessionUpdate: u.sessionUpdate }, "session update received");

        // Emit raw notification for adapter (streaming, tool progress)
        self.emit("notification", "session/update", { update: u });

        // Track tool calls
        const tool = parser.toolCall(u);
        if (tool) self.metrics.toolCalls.push(tool);

        // Turn boundary — emit turn_message and reset
        if (parser.isTurnEnd(u)) {
          const text = self._promptFullMessage ?? self._promptChunks.join("");
          if (text) self.emit("turn_message", text);
          self._promptChunks = [];
          self._promptFullMessage = null;
          return;
        }

        // Accumulate chunks
        const chunk = parser.messageChunk(u);
        if (chunk !== null) {
          self._promptChunks.push(chunk);
          self.metrics.chunkCount++;
          self.metrics.charCount += chunk.length;
        }

        // Full message
        const full = parser.fullMessage(u);
        if (full !== null) {
          self._promptFullMessage = full;
        }
      },

      async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
        const allowOption = params.options.find((o) => o.kind === "allow_always")
          || params.options.find((o) => o.kind === "allow_once")
          || params.options[0];
        return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
      },

      async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
        const p = params.path.startsWith("/")
          ? params.path
          : path.join(WORKSPACE, params.path);
        return { content: fs.readFileSync(p, "utf-8") };
      },

      async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
        const p = params.path.startsWith("/")
          ? params.path
          : path.join(WORKSPACE, params.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, params.content, "utf-8");
        self.metrics.filesModified.push(p);
        return {};
      },

      async createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
        return { terminalId: `term-${Date.now()}` };
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
      // SDK doesn't expose ping directly, use a lightweight prompt check
      // For now, check if the process is alive
      return this.proc?.exitCode === null;
    } catch {
      return false;
    }
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.conn = null;
  }
}
