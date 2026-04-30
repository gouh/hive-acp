/**
 * TripleStore — in-memory knowledge graph with JSON file persistence.
 *
 * Stores SPO triples, deduplicates by s+p+o, flushes to disk on a
 * debounced timer, and prunes oldest entries beyond MAX_TRIPLES.
 */

import fs from "node:fs";
import type { Triple } from "./types.js";
import { log } from "../utils/logger.js";
import { HIVE_TRIPLES_PATH } from "../utils/paths.js";

const MAX_TRIPLES = 500;
const FLUSH_DELAY_MS = 5_000;

export class TripleStore {
  private triples: Triple[] = [];
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  add(s: string, p: string, o: string): void {
    const existing = this.triples.find((t) => t.s === s && t.p === p && t.o === o);
    if (existing) {
      existing.t = Date.now();
    } else {
      this.triples.push({ s, p, o, t: Date.now() });
      this.prune();
    }
    this.scheduleDirtyFlush();
  }

  remove(s: string, p: string, o: string): boolean {
    const idx = this.triples.findIndex((t) => t.s === s && t.p === p && t.o === o);
    if (idx === -1) return false;
    this.triples.splice(idx, 1);
    this.scheduleDirtyFlush();
    return true;
  }

  query(opts: { s?: string; p?: string; o?: string }): Triple[] {
    return this.triples.filter(
      (t) =>
        (!opts.s || t.s === opts.s) &&
        (!opts.p || t.p === opts.p) &&
        (!opts.o || t.o === opts.o),
    );
  }

  search(keyword: string): Triple[] {
    const k = keyword.toLowerCase();
    return this.triples.filter(
      (t) => t.s.toLowerCase().includes(k) || t.o.toLowerCase().includes(k),
    );
  }

  toContext(): string {
    if (this.triples.length === 0) return "";
    return this.triples
      .slice()
      .sort((a, b) => b.t - a.t)
      .slice(0, 30)
      .map((t) => `${t.s} ${t.p} ${t.o}`)
      .join("\n");
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    fs.writeFileSync(HIVE_TRIPLES_PATH, JSON.stringify(this.triples, null, 2), "utf-8");
    this.dirty = false;
    log.main.debug({ count: this.triples.length }, "triples flushed to disk");
  }

  private load(): void {
    if (!fs.existsSync(HIVE_TRIPLES_PATH)) return;
    try {
      this.triples = JSON.parse(fs.readFileSync(HIVE_TRIPLES_PATH, "utf-8"));
      log.main.info({ count: this.triples.length }, "triples loaded");
    } catch {
      log.main.warn("failed to parse triples.json, starting empty");
      this.triples = [];
    }
  }

  private prune(): void {
    if (this.triples.length <= MAX_TRIPLES) return;
    this.triples.sort((a, b) => b.t - a.t);
    this.triples.length = MAX_TRIPLES;
  }

  private scheduleDirtyFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
  }
}
