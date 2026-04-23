/**
 * ACP Pool — manages one AcpClient per chat, with idle cleanup.
 */

import { AcpClient } from "./client.js";
import { log } from "../utils/logger.js";

const IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // check every minute

interface PoolEntry {
  client: AcpClient;
  lastUsed: number;
}

export class AcpPool {
  private pool = new Map<number, PoolEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
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

    client.on("exit", () => {
      log.acp.warn("AcpClient for chat %d exited, removing from pool", chatId);
      this.pool.delete(chatId);
    });

    this.pool.set(chatId, { client, lastUsed: Date.now() });
    return client;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [chatId, entry] of this.pool) {
      if (now - entry.lastUsed > IDLE_TTL_MS) {
        log.acp.info("Evicting idle AcpClient for chat %d", chatId);
        entry.client.stop();
        this.pool.delete(chatId);
      }
    }
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
    for (const [, entry] of this.pool) {
      entry.client.stop();
    }
    this.pool.clear();
  }
}
