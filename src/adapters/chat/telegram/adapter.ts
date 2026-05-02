/**
 * Telegram Adapter — connects Telegram Bot API to the ACP client via grammy.
 * Implements the platform-agnostic ChatAdapter interface.
 *
 * Delivery strategy (inspired by Telegram-ACP):
 * - HTML as primary parse mode (more predictable than Markdown)
 * - OutboundThrottle with RetryAfter handling
 * - Accumulate chunks, send complete message at end (no editMessageText streaming)
 * - UTF-8 safe message splitting
 */

import { Bot, type Context, InputFile, GrammyError } from "grammy";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AcpPool } from "../../../acp/pool.js";
import type { JobManager } from "../../../orchestration/job-manager.js";
import type { JobEvent } from "../../../orchestration/types.js";
import type { ChatAdapter, ChatContext } from "../types.js";
import { log } from "../../../utils/logger.js";

const TELEGRAM_MAX_LENGTH = 4096;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

// ── HTML formatting ──────────────────────────────────────────

/** Escape text for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert agent Markdown to Telegram HTML.
 * Handles: **bold**, *italic*, `code`, ```blocks```, [links](url), ~~strike~~
 * Preserves code blocks untouched.
 */
function mdToHtml(text: string): string {
  const codeBlocks: string[] = [];

  // Extract code blocks first
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    codeBlocks.push(lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  // Extract inline code
  result = result.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CB${idx}\x00`;
  });

  // Escape HTML in remaining text
  result = escapeHtml(result);

  // Markdown → HTML conversions
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/\*(.+?)\*/g, "<i>$1</i>");
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Strip MarkdownV2 escapes (e.g. \. \- \( \))
  result = result.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");

  // Restore code blocks
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)]);

  return result;
}

// ── OutboundThrottle ─────────────────────────────────────────

/** Rate-limit outbound Telegram API calls with RetryAfter handling. */
class OutboundThrottle {
  private nextAllowedAt = 0;

  constructor(private minIntervalMs = 2000) {}

  /** Wait until we can send. */
  async wait(): Promise<void> {
    const now = Date.now();
    if (this.nextAllowedAt > now) {
      await new Promise((r) => setTimeout(r, this.nextAllowedAt - now));
    }
    this.nextAllowedAt = Date.now() + this.minIntervalMs;
  }

  /** Check if we can send now (non-blocking). */
  tryNow(): boolean {
    const now = Date.now();
    if (this.nextAllowedAt > now) return false;
    this.nextAllowedAt = now + this.minIntervalMs;
    return true;
  }

  /** Defer next send by a duration (e.g. after RetryAfter). */
  defer(ms: number): void {
    const retryAt = Date.now() + ms;
    if (retryAt > this.nextAllowedAt) this.nextAllowedAt = retryAt;
  }
}

/** Extract RetryAfter seconds from a GrammyError, or null. */
function getRetryAfter(err: any): number | null {
  if (err instanceof GrammyError && err.error_code === 429) {
    const match = err.description?.match(/retry after (\d+)/i);
    return match ? parseInt(match[1]) : 5;
  }
  return null;
}

// ── UTF-8 safe message splitting ─────────────────────────────

/** Split text into chunks that fit within maxLen, respecting UTF-8 char boundaries. */
function splitMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find a safe split point: prefer double newline, then single newline, then maxLen
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    // Ensure we don't split in the middle of a multi-byte character
    while (splitAt > 0 && isContinuationByte(remaining, splitAt)) {
      splitAt--;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  return chunks;
}

/** Check if byte at position is a UTF-8 continuation byte (0x80-0xBF). */
function isContinuationByte(str: string, pos: number): boolean {
  const code = str.charCodeAt(pos);
  // Surrogate pair check — don't split between high and low surrogates
  return code >= 0xDC00 && code <= 0xDFFF;
}

// ── Adapter ──────────────────────────────────────────────────

export class TelegramAdapter implements ChatAdapter {
  readonly bot: Bot;
  private pool: AcpPool;
  private allowedUsers: Set<string>;
  private processing = new Set<string>();
  private activeCtx = new Map<number, ChatContext>();
  private contextBuilder?: (chatId: number) => string | null;

  getActiveContext(chatId?: number): ChatContext | null {
    if (chatId) return this.activeCtx.get(chatId) ?? null;
    const first = this.activeCtx.values().next();
    return first.done ? null : first.value;
  }

  constructor(token: string, pool: AcpPool) {
    this.bot = new Bot(token);
    this.pool = pool;
    this.allowedUsers = new Set(
      (process.env.HIVE_ALLOWED_USERS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    );
  }

  start(): void {
    this.bot.on("message", (ctx) => this.onMessage(ctx));
    this.bot.catch((err) => {
      log.telegram.warn({ err: err.message }, "bot error");
    });
    this.bot.start();
    log.telegram.info("listening for messages");
  }

  setContextBuilder(fn: (chatId: number) => string | null): void {
    this.contextBuilder = fn;
  }

  stop(): void {
    this.bot.stop();
  }

  // ── ChatAdapter: sendPhoto / sendFile ──────────────────────

  async sendPhoto(chatId: number, filePath: string, caption?: string): Promise<void> {
    await this.bot.api.sendPhoto(chatId, new InputFile(filePath), caption ? { caption } : {});
  }

  async sendFile(chatId: number, filePath: string, caption?: string): Promise<void> {
    await this.bot.api.sendDocument(chatId, new InputFile(filePath), caption ? { caption } : {});
  }

  // ── Throttled send helpers ─────────────────────────────────

  /** Send an HTML message with throttle and RetryAfter handling. */
  private async sendHtml(chatId: number, text: string, throttle: OutboundThrottle): Promise<void> {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await this.sendSingleHtml(chatId, chunk, throttle);
    }
  }

  private async sendSingleHtml(chatId: number, text: string, throttle: OutboundThrottle): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await throttle.wait();
      try {
        await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
        return;
      } catch (err: any) {
        const retryAfter = getRetryAfter(err);
        if (retryAfter !== null) {
          log.telegram.warn({ chatId, retryAfter }, "rate limited, backing off");
          throttle.defer((retryAfter + 1) * 1000);
          continue;
        }
        // HTML parse failed — try plain text
        log.telegram.warn({ chatId, err: err.message }, "HTML send failed, trying plain text");
        try {
          await this.bot.api.sendMessage(chatId, text);
          return;
        } catch (err2: any) {
          log.telegram.error({ chatId, err: err2.message }, "plain text send also failed");
          return;
        }
      }
    }
  }

  /** Edit an HTML message with throttle. Non-critical — drops on throttle. */
  private async editHtml(chatId: number, msgId: number, text: string, throttle: OutboundThrottle): Promise<boolean> {
    if (!throttle.tryNow()) return false;
    try {
      await this.bot.api.editMessageText(chatId, msgId, text, { parse_mode: "HTML" });
      return true;
    } catch (err: any) {
      if (err.message?.includes("message is not modified")) return true;
      const retryAfter = getRetryAfter(err);
      if (retryAfter !== null) {
        throttle.defer((retryAfter + 1) * 1000);
        return false;
      }
      // HTML failed — try plain
      try {
        await this.bot.api.editMessageText(chatId, msgId, text);
        return true;
      } catch {
        return false;
      }
    }
  }

  // ── ChatAdapter: bindJobManager ────────────────────────────

  bindJobManager(jobManager: JobManager, pool: AcpPool): void {
    const subagentMsgs = new Map<string, { msgId: number; tools: string[] }>();
    const throttle = new OutboundThrottle(2000);

    jobManager.on("event", (evt: JobEvent) => {
      if (evt.type === "task:tool" && evt.task && evt.toolName) {
        const key = evt.task.id;
        const state = subagentMsgs.get(key) || { msgId: 0, tools: [] };
        state.tools.push(escapeHtml(evt.toolName));

        const lines = state.tools.slice(-5).map((t) =>
          t.startsWith("✅") || t.startsWith("❌") ? `<i>${t}</i>` : `⚙️ <i>${t}</i>`
        );
        const text = `🤖 <i>${escapeHtml(evt.task.agent)}</i>\n${lines.join("\n")}`;

        if (state.msgId) {
          this.editHtml(evt.chatId, state.msgId, text, throttle);
        } else {
          throttle.wait().then(() =>
            this.bot.api.sendMessage(evt.chatId, text, { parse_mode: "HTML" })
              .then((m) => { state.msgId = m.message_id; })
              .catch(() => {})
          );
        }
        subagentMsgs.set(key, state);
        return;
      }

      if (evt.type === "task:tool_update" && evt.task && evt.toolStatus) {
        const key = evt.task.id;
        const state = subagentMsgs.get(key);
        if (!state || !state.msgId) return;

        if (evt.toolStatus === "completed" || evt.toolStatus === "failed") {
          const icon = evt.toolStatus === "completed" ? "✅" : "❌";
          const last = state.tools.length - 1;
          if (last >= 0) state.tools[last] = `${icon} ${state.tools[last]}`;
          const lines = state.tools.slice(-5).map((t) =>
            t.startsWith("✅") || t.startsWith("❌") ? `<i>${t}</i>` : `⚙️ <i>${t}</i>`
          );
          this.editHtml(evt.chatId, state.msgId, lines.join("\n"), throttle);
        }
        return;
      }

      if (evt.type === "task:complete" && evt.task) {
        const state = subagentMsgs.get(evt.task.id);
        if (state?.msgId) {
          this.bot.api.deleteMessage(evt.chatId, state.msgId).catch(() => {});
          subagentMsgs.delete(evt.task.id);
        }
        const summary = evt.task.result?.slice(0, 4000) || "(no output)";
        pool.inject(evt.chatId, `[SUBAGENT RESULT] ${evt.task.agent} completed:\n${summary}`);
      }
      if (evt.type === "task:failed" && evt.task) {
        const state = subagentMsgs.get(evt.task.id);
        if (state?.msgId) {
          this.bot.api.deleteMessage(evt.chatId, state.msgId).catch(() => {});
          subagentMsgs.delete(evt.task.id);
        }
        pool.inject(evt.chatId, `[SUBAGENT FAILED] ${evt.task.agent}: ${evt.task.error || "unknown"}`);
      }
      if (evt.type === "job:complete" && evt.job) {
        const typingInterval = setInterval(
          () => this.bot.api.sendChatAction(evt.chatId, "typing").catch(() => {}),
          4000,
        );
        this.bot.api.sendChatAction(evt.chatId, "typing").catch(() => {});

        pool.drainToAgent(evt.chatId)
          .then((response) => {
            clearInterval(typingInterval);
            if (response) return this.sendResponse(evt.chatId, response);
            const done = evt.job!.tasks.filter((t) => t.status === "done").length;
            return this.sendResponse(evt.chatId, `📋 Job ${evt.jobId} finished — ${done}/${evt.job!.tasks.length} tasks completed`);
          })
          .catch((err) => {
            clearInterval(typingInterval);
            log.telegram.warn({ err: err.message }, "drain notification failed");
          });
      }
    });
  }

  // ── Message handling ───────────────────────────────────────

  private async onMessage(ctx: Context): Promise<void> {
    const msg = ctx.message!;
    const chatId = msg.chat.id;
    const userId = String(msg.from!.id);
    const text = msg.text?.trim() || msg.caption?.trim() || "";
    const hasPhoto = !!(msg.photo && msg.photo.length > 0);
    const hasDocument = !!msg.document;

    if (!text && !hasPhoto && !hasDocument) return;

    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId)) {
      await ctx.reply("⛔ Not authorized.");
      return;
    }

    if (this.processing.has(userId)) {
      await this.pool.inject(chatId, `[QUEUED MESSAGE from user] ${text}`);
      await ctx.reply("📥 Message received, I'll respond when I finish the current task.");
      return;
    }

    this.processing.add(userId);
    log.telegram.info({ chatId, userId, preview: text.slice(0, 80) || (hasPhoto ? "[photo]" : "[document]") }, "message received");

    let typingInterval: ReturnType<typeof setInterval> | null = null;
    let acpInstance: any = null;
    const eventCleanups: Array<() => void> = [];
    const throttle = new OutboundThrottle(2000);

    try {
      this.activeCtx.set(chatId, {
        chatId,
        messageId: msg.message_id,
        replyToMessageId: msg.reply_to_message?.message_id,
      });

      await ctx.replyWithChatAction("typing");
      typingInterval = setInterval(
        () => ctx.replyWithChatAction("typing").catch(() => {}),
        4000
      );

      const prompt = await this.buildPrompt(ctx, text);
      const acp = await this.pool.get(chatId);
      acpInstance = acp;
      this.pool.setBusy(chatId, true);

      const prefix = this.pool.consumePrefix(chatId);
      const queued = this.pool.consumeQueue(chatId);
      const dynCtx = this.contextBuilder?.(chatId) ?? null;
      const preamble = [prefix, dynCtx, queued].filter(Boolean).join("\n\n");
      if (preamble && prompt.length > 0 && prompt[0].type === "text") {
        prompt[0].text = `${preamble}\n\n${prompt[0].text}`;
      }

      // Accumulation state
      let streamBuffer = "";
      let totalStreamedChars = 0;

      // Tool progress state
      let toolMsgId: number | null = null;
      const toolNames: string[] = [];

      // Typed event listeners
      const onChunk = (text: string) => {
        streamBuffer += text;
        totalStreamedChars += text.length;
      };

      const onTool = (name: string, _id: string) => {
        toolNames.push(escapeHtml(name));
        const lines = toolNames.slice(-6).map((t) => `⚙️ <i>${t}</i>`);
        const toolText = lines.join("\n");
        if (toolMsgId) {
          this.editHtml(chatId, toolMsgId, toolText, throttle);
        } else if (throttle.tryNow()) {
          this.bot.api.sendMessage(chatId, toolText, { parse_mode: "HTML" })
            .then((m) => { toolMsgId = m.message_id; })
            .catch(() => {});
        }
      };

      const onToolUpdate = (_id: string, status: string) => {
        if (toolMsgId && (status === "completed" || status === "failed")) {
          const icon = status === "completed" ? "✅" : "❌";
          const last = toolNames.length - 1;
          if (last >= 0) toolNames[last] = `${icon} ${toolNames[last]}`;
          const lines = toolNames.slice(-6).map((t) =>
            t.startsWith("✅") || t.startsWith("❌") ? `<i>${t}</i>` : `⚙️ <i>${t}</i>`
          );
          this.editHtml(chatId, toolMsgId, lines.join("\n"), throttle);
        }
      };

      const onTurnEnd = async () => {
        if (streamBuffer) {
          if (toolMsgId) {
            this.bot.api.deleteMessage(chatId, toolMsgId).catch(() => {});
            toolMsgId = null;
            toolNames.length = 0;
          }
          await this.sendHtml(chatId, mdToHtml(streamBuffer), throttle);
          streamBuffer = "";
        }
      };

      acp.on("chunk", onChunk);
      acp.on("tool", onTool);
      acp.on("tool_update", onToolUpdate);
      acp.on("turn_end", onTurnEnd);
      eventCleanups.push(
        () => acp.removeListener("chunk", onChunk),
        () => acp.removeListener("tool", onTool),
        () => acp.removeListener("tool_update", onToolUpdate),
        () => acp.removeListener("turn_end", onTurnEnd),
      );

      const response = await acp.prompt(prompt);

      // Clean up tool progress
      if (toolMsgId) {
        this.bot.api.deleteMessage(chatId, toolMsgId).catch(() => {});
      }

      // Send any remaining accumulated text
      if (streamBuffer) {
        await this.sendHtml(chatId, mdToHtml(streamBuffer), throttle);
      } else if (totalStreamedChars === 0) {
        await this.sendHtml(chatId, mdToHtml(response || "_(no response)_"), throttle);
      }

      log.telegram.info({ chatId, userId, preview: (response || "").slice(0, 100) }, "response sent");
    } catch (err: any) {
      log.telegram.error({ err, chatId }, "message handling failed");
      if (err.message?.includes("Timeout") || err.message?.includes("exited")) {
        log.telegram.warn({ chatId }, "recycling dead client");
        this.pool.kill(chatId);
      }
      await ctx.reply(`❌ Error: ${err.message}`);
    } finally {
      for (const cleanup of eventCleanups) cleanup();
      if (typingInterval) clearInterval(typingInterval);
      this.pool.setBusy(chatId, false);
      this.processing.delete(userId);
    }
  }

  // ── Prompt building ────────────────────────────────────────

  private async buildPrompt(
    ctx: Context,
    text: string,
  ): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
    const msg = ctx.message!;
    const parts: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];

    let header = `[telegram: message_id=${msg.message_id}, chat_id=${msg.chat.id}]\n`;
    if (msg.reply_to_message) {
      const replyText = msg.reply_to_message.text || "(non-text message)";
      header += `[replying_to: message_id=${msg.reply_to_message.message_id}, text="${replyText.slice(0, 200)}"]\n`;
    }
    if (text) header += text;

    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      const imageData = await this.downloadFileAsBase64(ctx, photo.file_id);
      if (imageData) {
        if (!text) header += "[The user sent a photo]";
        parts.push({ type: "text", text: header });
        parts.push({ type: "image", data: imageData.base64, mimeType: imageData.mimeType });
        return parts;
      }
    }

    if (msg.document) {
      const ext = path.extname(msg.document.file_name || "").toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        const imageData = await this.downloadFileAsBase64(ctx, msg.document.file_id);
        if (imageData) {
          if (!text) header += `[The user sent an image file: ${msg.document.file_name}]`;
          parts.push({ type: "text", text: header });
          parts.push({ type: "image", data: imageData.base64, mimeType: imageData.mimeType });
          return parts;
        }
      }
      const filePath = await this.downloadFileToTemp(ctx, msg.document.file_id, msg.document.file_name || "file");
      if (filePath) {
        if (!text) header += `[The user sent a file: ${msg.document.file_name}]`;
        header += `\n[File saved to: ${filePath}]`;
      }
    }

    parts.push({ type: "text", text: header });
    return parts;
  }

  private async downloadFileAsBase64(ctx: Context, fileId: string): Promise<{ base64: string; mimeType: string } | null> {
    try {
      const file = await ctx.api.getFile(fileId);
      const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const ext = path.extname(file.file_path || "").toLowerCase();
      const mimeMap: Record<string, string> = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
      };
      return { base64: buffer.toString("base64"), mimeType: mimeMap[ext] || "image/jpeg" };
    } catch (err: any) {
      log.telegram.error({ err: err.message }, "failed to download file");
      return null;
    }
  }

  private async downloadFileToTemp(ctx: Context, fileId: string, fileName: string): Promise<string | null> {
    try {
      const file = await ctx.api.getFile(fileId);
      const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const tmpPath = path.join(os.tmpdir(), `telegram-${Date.now()}-${fileName}`);
      fs.writeFileSync(tmpPath, buffer);
      return tmpPath;
    } catch (err: any) {
      log.telegram.error({ err: err.message }, "failed to download file");
      return null;
    }
  }

  async sendResponse(chatId: number, text: string): Promise<void> {
    const throttle = new OutboundThrottle(2000);
    await this.sendHtml(chatId, mdToHtml(text), throttle);
  }
}
