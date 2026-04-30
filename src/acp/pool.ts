/**
 * ACP Pool — manages one AcpClient per chat, with idle cleanup.
 * Persists conversation snapshots to disk on eviction and restores on reconnect.
 *
 * Features:
 * - Watchdog: health check every 10s, auto-restart dead clients with context
 * - Context-aware eviction: evicts by idle time OR estimated token usage
 * - Rich snapshots: saves summary + tool calls + files modified
 */

import fs from "node:fs";
import path from "node:path";
import { AcpClient } from "./client.js";
import type { CliProvider } from "./providers/types.js";
import type { ProviderRegistry } from "./registry.js";
import type { TripleStore } from "../memory/store.js";
import { log } from "../utils/logger.js";
import { HIVE_SUMMARIES_DIR } from "../utils/paths.js";

const IDLE_TTL_MS = 30 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 10_000;
const MAX_ESTIMATED_TOKENS = 120_000;

interface PoolEntry {
  client: AcpClient;
  lastUsed: number;
  /** If true, a prompt is in flight — skip health checks. */
  busy: boolean;
}

/** Rich snapshot persisted on eviction. */
interface Snapshot {
  summary: string;
  toolCalls: string[];
  filesModified: string[];
  estimatedTokens: number;
  evictedAt: number;
}

export class AcpPool {
  private pool = new Map<number, PoolEntry>();
  private injectQueue = new Map<number, string[]>();
  private contextPrefix = new Map<number, string>();
  private watchdogTimer: ReturnType<typeof setInterval>;

  private provider: CliProvider;
  private agentName: string;
  private instructions?: string;

  constructor(private registry: ProviderRegistry, private store: TripleStore, orchestrator: string) {
    const provider = registry.resolve(orchestrator);
    if (!provider) throw new Error(`No provider found for orchestrator "${orchestrator}"`);
    this.provider = provider;
    this.agentName = orchestrator;
    this.instructions = !provider.agentFlag ? registry.getInstructions(orchestrator) : undefined;
    this.watchdogTimer = setInterval(() => this.watchdog(), WATCHDOG_INTERVAL_MS);
  }

  get cliProvider(): CliProvider {
    return this.provider;
  }

  async get(chatId: number): Promise<AcpClient> {
    const entry = this.pool.get(chatId);
    if (entry) {
      entry.lastUsed = Date.now();
      return entry.client;
    }

    log.acp.info({ chatId }, "creating new client");
    const client = new AcpClient(this.provider, this.provider.agentFlag ? this.agentName : undefined);
    await client.start();

    // Queue previous context to prepend to the first user message
    const snapshot = this.loadSnapshot(chatId);
    const graph = this.store.toContext();
    const parts: string[] = [];
    if (this.instructions) parts.push(`[AGENT INSTRUCTIONS]\n${this.instructions}\n[END INSTRUCTIONS]`);
    if (graph) parts.push(`[KNOWLEDGE GRAPH]\n${graph}\n[END GRAPH]`);
    if (snapshot) {
      parts.push(`[PREVIOUS SUMMARY]\n${snapshot.summary}\n[END SUMMARY]`);
      if (snapshot.filesModified.length > 0) {
        parts.push(`[FILES PREVIOUSLY MODIFIED]\n${snapshot.filesModified.join("\n")}\n[END FILES]`);
      }
    }

    if (parts.length > 0) {
      log.acp.info({ chatId, hasGraph: !!graph, hasSnapshot: !!snapshot }, "queuing previous context");
      this.contextPrefix.set(chatId, parts.join("\n\n"));
    }

    client.on("exit", () => {
      log.acp.warn({ chatId }, "client exited, removing from pool");
      this.pool.delete(chatId);
    });

    this.pool.set(chatId, { client, lastUsed: Date.now(), busy: false });
    return client;
  }

  /** Mark a client as busy (prompt in flight) to skip watchdog health checks. */
  setBusy(chatId: number, busy: boolean): void {
    const entry = this.pool.get(chatId);
    if (entry) entry.busy = busy;
  }

  /** Kill and remove a client from the pool (e.g. after timeout). */
  kill(chatId: number): void {
    const entry = this.pool.get(chatId);
    if (entry) {
      entry.client.stop();
      this.pool.delete(chatId);
      log.acp.info({ chatId }, "client killed and removed from pool");
    }
  }

  private async evict(chatId: number, entry: PoolEntry): Promise<void> {
    log.acp.info({ chatId, tokens: entry.client.estimatedTokens }, "evicting client, requesting summary");

    // Feature 5: Rich snapshot — summary + metrics
    const summary = await entry.client.summarize();
    if (summary) {
      const snapshot: Snapshot = {
        summary,
        toolCalls: [...new Set(entry.client.metrics.toolCalls)],
        filesModified: [...new Set(entry.client.metrics.filesModified)],
        estimatedTokens: entry.client.estimatedTokens,
        evictedAt: Date.now(),
      };
      this.saveSnapshot(chatId, snapshot);
      log.acp.info({ chatId, summaryLen: summary.length, tools: snapshot.toolCalls.length, files: snapshot.filesModified.length }, "snapshot saved");
    }

    const triples = await entry.client.extractTriples();
    for (const { s, p, o } of triples) this.store.add(s, p, o);
    if (triples.length > 0) {
      log.acp.info({ chatId, count: triples.length }, "triples extracted");
      this.store.flush();
    }

    entry.client.stop();
    this.pool.delete(chatId);
  }

  /**
   * Watchdog — runs every 10s.
   * - Evicts idle clients (>30 min) or context-heavy clients (>120k tokens)
   * - Health-checks idle clients (>2 min, not busy)
   * - Auto-restarts dead clients with context preserved
   */
  private async watchdog(): Promise<void> {
    const now = Date.now();
    for (const [chatId, entry] of this.pool) {
      const idle = now - entry.lastUsed;

      // Evict by idle time
      if (idle > IDLE_TTL_MS) {
        await this.evict(chatId, entry);
        continue;
      }

      // Evict by context usage (Feature 3)
      if (entry.client.estimatedTokens > MAX_ESTIMATED_TOKENS) {
        log.acp.warn({ chatId, tokens: entry.client.estimatedTokens }, "context limit reached, evicting");
        await this.evict(chatId, entry);
        continue;
      }

      // Health check — skip busy clients and recently active ones.
      // Use 10 min idle threshold to avoid killing clients during long drain/prompt operations.
      if (!entry.busy && idle > 10 * 60 * 1000) {
        const alive = await entry.client.ping();
        if (!alive) {
          log.acp.warn({ chatId }, "watchdog: dead client, auto-restarting");
          entry.client.stop();
          this.pool.delete(chatId);

          // Auto-restart: next pool.get() will create a fresh client with snapshot context
          // No action needed — the snapshot is already on disk from any prior eviction,
          // and if this is a crash (no eviction), we save what we can from metrics.
          const snapshot: Snapshot = {
            summary: "(agent crashed — context lost)",
            toolCalls: [...new Set(entry.client.metrics.toolCalls)],
            filesModified: [...new Set(entry.client.metrics.filesModified)],
            estimatedTokens: entry.client.estimatedTokens,
            evictedAt: Date.now(),
          };
          this.saveSnapshot(chatId, snapshot);
        }
      }
    }
  }

  // ── Snapshot persistence ──────────────────────────────────────────

  private snapshotPath(chatId: number): string {
    return path.join(HIVE_SUMMARIES_DIR, `${chatId}.json`);
  }

  /** Legacy .md path for backward compat. */
  private legacySummaryPath(chatId: number): string {
    return path.join(HIVE_SUMMARIES_DIR, `${chatId}.md`);
  }

  private saveSnapshot(chatId: number, snapshot: Snapshot): void {
    fs.writeFileSync(this.snapshotPath(chatId), JSON.stringify(snapshot, null, 2), "utf-8");
    // Clean up legacy .md if it exists
    const legacy = this.legacySummaryPath(chatId);
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  }

  private loadSnapshot(chatId: number): Snapshot | null {
    // Try new JSON format first
    const p = this.snapshotPath(chatId);
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* fall through */ }
    }
    // Fall back to legacy .md
    const legacy = this.legacySummaryPath(chatId);
    if (fs.existsSync(legacy)) {
      const summary = fs.readFileSync(legacy, "utf-8").trim();
      if (summary) return { summary, toolCalls: [], filesModified: [], estimatedTokens: 0, evictedAt: 0 };
    }
    return null;
  }

  saveSummary(chatId: number, summary: string): void {
    const existing = this.loadSnapshot(chatId);
    const entry = this.pool.get(chatId);
    const snapshot: Snapshot = {
      summary,
      toolCalls: existing?.toolCalls ?? (entry ? [...new Set(entry.client.metrics.toolCalls)] : []),
      filesModified: existing?.filesModified ?? (entry ? [...new Set(entry.client.metrics.filesModified)] : []),
      estimatedTokens: entry?.client.estimatedTokens ?? existing?.estimatedTokens ?? 0,
      evictedAt: Date.now(),
    };
    this.saveSnapshot(chatId, snapshot);
  }

  loadSummary(chatId: number): string | null {
    return this.loadSnapshot(chatId)?.summary ?? null;
  }

  deleteSummary(chatId: number): boolean {
    let deleted = false;
    for (const p of [this.snapshotPath(chatId), this.legacySummaryPath(chatId)]) {
      if (fs.existsSync(p)) { fs.unlinkSync(p); deleted = true; }
    }
    return deleted;
  }

  /** Queue a message to inject into a client's conversation on next interaction. */
  async inject(chatId: number, message: string): Promise<void> {
    const queue = this.injectQueue.get(chatId) || [];
    queue.push(message);
    this.injectQueue.set(chatId, queue);
    log.acp.debug({ chatId, queued: queue.length }, "message queued for injection");
  }

  /** Consume and return queued injections as a single string, or null if empty. */
  consumeQueue(chatId: number): string | null {
    const queue = this.injectQueue.get(chatId);
    if (!queue || queue.length === 0) return null;
    this.injectQueue.delete(chatId);
    log.acp.info({ chatId, count: queue.length }, "consuming inject queue");
    return queue.join("\n\n");
  }

  /** Consume and return any pending context prefix for a chat. */
  consumePrefix(chatId: number): string | null {
    const prefix = this.contextPrefix.get(chatId);
    if (!prefix) return null;
    this.contextPrefix.delete(chatId);
    return prefix;
  }

  /**
   * Drain queued messages by sending them as a prompt to the orchestrator agent.
   * Returns the agent's response, or null if there was nothing to drain or no active client.
   */
  async drainToAgent(chatId: number): Promise<string | null> {
    const queued = this.consumeQueue(chatId);
    if (!queued) return null;

    const entry = this.pool.get(chatId);
    if (!entry) return null;

    // If the client is busy (user prompt in flight), re-queue and let the
    // next user interaction pick it up via consumeQueue.
    if (entry.busy) {
      log.acp.debug({ chatId }, "client busy, re-queuing for next interaction");
      this.inject(chatId, queued);
      return null;
    }

    log.acp.info({ chatId }, "draining queue to agent");
    entry.busy = true;
    entry.lastUsed = Date.now();
    try {
      const result = await entry.client.prompt([{ type: "text", text: queued }]);
      entry.lastUsed = Date.now();
      return result;
    } catch (err: any) {
      log.acp.warn({ chatId, err: err.message }, "drain to agent failed");
      return null;
    } finally {
      entry.busy = false;
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.watchdogTimer);
    for (const [chatId, entry] of this.pool) {
      await this.evict(chatId, entry);
    }
  }
}
