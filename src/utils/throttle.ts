/**
 * OutboundThrottle — rate-limit outbound API calls with RetryAfter handling.
 *
 * Extracted from TelegramAdapter for reuse across adapters.
 */

import { GrammyError } from "grammy";

export class OutboundThrottle {
  private nextAllowedAt = 0;

  constructor(private minIntervalMs = 2000) {}

  async wait(): Promise<void> {
    const now = Date.now();
    if (this.nextAllowedAt > now) {
      await new Promise((r) => setTimeout(r, this.nextAllowedAt - now));
    }
    this.nextAllowedAt = Date.now() + this.minIntervalMs;
  }

  tryNow(): boolean {
    const now = Date.now();
    if (this.nextAllowedAt > now) return false;
    this.nextAllowedAt = now + this.minIntervalMs;
    return true;
  }

  defer(ms: number): void {
    const retryAt = Date.now() + ms;
    if (retryAt > this.nextAllowedAt) this.nextAllowedAt = retryAt;
  }
}

/** Extract RetryAfter seconds from a GrammyError, or null. */
export function getRetryAfter(err: unknown): number | null {
  if (err instanceof GrammyError && err.error_code === 429) {
    const match = err.description?.match(/retry after (\d+)/i);
    return match ? parseInt(match[1]) : 5;
  }
  return null;
}
