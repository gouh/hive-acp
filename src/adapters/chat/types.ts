/**
 * ChatAdapter — platform-agnostic interface for chat adapters.
 *
 * Any chat platform (Telegram, Slack, Discord, etc.) implements this
 * interface so that tools and the core logic remain decoupled.
 */

import type { AcpPool } from "../../acp/pool.js";
import type { JobManager } from "../../orchestration/job-manager.js";

export interface ChatContext {
  chatId: number;
  messageId: number;
  replyToMessageId?: number;
}

export interface ChatAdapter {
  /** Get the active context for a chat (or the first available). */
  getActiveContext(chatId?: number): ChatContext | null;

  /** Send a text message to a chat. */
  sendResponse(chatId: number, text: string): Promise<void>;

  /** Send a photo file to a chat. */
  sendPhoto(chatId: number, filePath: string, caption?: string): Promise<void>;

  /** Send a document/file to a chat. */
  sendFile(chatId: number, filePath: string, caption?: string): Promise<void>;

  /** Wire up job events for subagent visibility. */
  bindJobManager(jobManager: JobManager, pool: AcpPool): void;

  /** Start listening for messages. */
  start(): void;

  /** Stop the adapter. */
  stop(): void;
}
