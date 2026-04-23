/**
 * ACP Pool — manages one AcpClient per chat, with idle cleanup.
 * Persists conversation summaries to disk on eviction and restores on reconnect.
 */

import fs from "node:fs";
import path from "node:path";
import { AcpClient } from "./client.js";
import { log } from "../utils/logger.js";

const IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // check every minute
const SUMMARIES_DIR = path.join(process.cwd(), ".state", "summaries");

interface PoolEntry {
  client: AcpClient;
  lastUsed: number;
}

export class AcpPool {
  private pool = new Map<number, PoolEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  async get(chatId: number): Promise<AcpClient> {
    const entry = this.pool.get(chatId);
    if (entry) {
      entry.lastUsed = Date.now();
      return entry.client;
    }

    log.acp.info("Creating new AcpClient for chat %d", chatId);
    const client = new AcpClient();
    await client.start();

    // Inject previous summary if exists
    const summary = this.loadSummary(chatId);
    if (summary) {
      log.acp.info("Injecting previous context for chat %d (%d chars)", chatId, summary.length);
      await client.prompt([{
        type: "text",
        text: `[CONTEXT FROM PREVIOUS SESSION]\n${summary}\n[END CONTEXT]\n\nAcknowledge you have this context. Do not repeat it. Just say "Context restored." and wait for the user's next message.`,
      }]);
    }

    client.on("exit", () => {
      log.acp.warn("AcpClient for chat %d exited, removing from pool", chatId);
      this.pool.delete(chatId);
    });

    this.pool.set(chatId, { client, lastUsed: Date.now() });
    return client;
  }

  private async evict(chatId: number, entry: PoolEntry): Promise<void> {
    log.acp.info("Evicting idle AcpClient for chat %d, requesting summary...", chatId);
    const summary = await entry.client.summarize();
    if (summary) {
      this.saveSummary(chatId, summary);
      log.acp.info("Summary saved for chat %d (%d chars)", chatId, summary.length);
    }
    entry.client.stop();
    this.pool.delete(chatId);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [chatId, entry] of this.pool) {
      if (now - entry.lastUsed > IDLE_TTL_MS) {
        this.evict(chatId, entry);
      }
    }
  }

  private summaryPath(chatId: number): string {
    return path.join(SUMMARIES_DIR, `${chatId}.txt`);
  }

  private saveSummary(chatId: number, summary: string): void {
    fs.writeFileSync(this.summaryPath(chatId), summary, "utf-8");
  }

  private loadSummary(chatId: number): string | null {
    const p = this.summaryPath(chatId);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf-8").trim() || null;
  }

  async stop(): Promise<void> {
    clearInterval(this.cleanupTimer);
    for (const [chatId, entry] of this.pool) {
      await this.evict(chatId, entry);
    }
  }
}
