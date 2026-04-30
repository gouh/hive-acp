/**
 * Telegram Adapter — connects Telegram Bot API to the ACP client via grammy.
 * Implements the platform-agnostic ChatAdapter interface.
 */

import { Bot, type Context, InputFile } from "grammy";
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

/** Convert standard Markdown to Telegram Markdown v1. */
function toTelegramMd(text: string): string {
  return text.replace(/```[\s\S]*?```|`[^`]+`|\*\*(.+?)\*\*/g, (m, bold) =>
    bold !== undefined ? `*${bold}*` : m,
  )
  .replace(/```[\s\S]*?```|`[^`]+`|\\([_*[\]()~`>#+\-=|{}.!])/g, (m, ch) =>
    ch !== undefined ? ch : m,
  );
}

/** Escape underscores for Telegram Markdown italic formatting. */
function escapeMd(text: string): string {
  return text.replace(/_/g, "\\_");
}

/** Returns true if the error is a benign "message not modified" from Telegram. */
function isNotModified(err: any): boolean {
  return typeof err?.message === "string" && err.message.includes("message is not modified");
}

export class TelegramAdapter implements ChatAdapter {
  readonly bot: Bot;
  private pool: AcpPool;
  private allowedUsers: Set<string>;
  private processing = new Set<string>();
  private activeCtx = new Map<number, ChatContext>();

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

  // ── ChatAdapter: bindJobManager ────────────────────────────

  bindJobManager(jobManager: JobManager, pool: AcpPool): void {
    const subagentMsgs = new Map<string, { msgId: number; tools: string[] }>();

    jobManager.on("event", (evt: JobEvent) => {
      if (evt.type === "task:progress" && evt.detail && evt.task) {
        const parser = evt.parser ?? pool.cliProvider.parser;
        const toolName = parser.toolCall(evt.detail);
        const toolUpdate = parser.toolCallUpdate(evt.detail);
        if (!toolName && !toolUpdate) return;

        const key = evt.task.id;
        const state = subagentMsgs.get(key) || { msgId: 0, tools: [] };

        if (toolName) {
          state.tools.push(escapeMd(toolName));
        }
        if (toolUpdate && (toolUpdate.status === "completed" || toolUpdate.status === "failed")) {
          const last = state.tools.length - 1;
          if (last >= 0) {
            const icon = toolUpdate.status === "completed" ? "✅" : "❌";
            state.tools[last] = `${icon} ${state.tools[last]}`;
          }
        }

        const text = `🤖 _${escapeMd(evt.task.agent)}_\n${state.tools.slice(-5).map((t) => t.startsWith("✅") || t.startsWith("❌") ? `_${t}_` : `⚙️ _${t}_`).join("\n")}`;
        if (state.msgId) {
          this.bot.api.editMessageText(evt.chatId, state.msgId, text, { parse_mode: "Markdown" }).catch(() => {});
        } else {
          this.bot.api.sendMessage(evt.chatId, text, { parse_mode: "Markdown" })
            .then((m) => { state.msgId = m.message_id; })
            .catch(() => {});
        }
        subagentMsgs.set(key, state);
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
    let responseSentViaStream = false;
    let notificationListener: ((method: string, params: any) => void) | null = null;
    let turnListener: ((_text: string) => Promise<void>) | null = null;

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
      const preamble = [prefix, queued].filter(Boolean).join("\n\n");
      if (preamble && prompt.length > 0 && prompt[0].type === "text") {
        prompt[0].text = `${preamble}\n\n${prompt[0].text}`;
      }

      // Streaming state
      const { parser } = this.pool.cliProvider;
      let streamMsgId: number | null = null;
      let streamBuffer = "";
      let lastEditedText = "";
      let totalStreamedChars = 0;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const SPLIT_THRESHOLD = 3000;

      // Tool progress state
      let toolMsgId: number | null = null;
      const toolNames: string[] = [];

      /** Adaptive debounce: fast at start, slower as text grows. */
      const debounceMs = () => streamBuffer.length < 500 ? 400 : 1200;

      const flushStream = async (final = false) => {
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        if (!streamBuffer) return;
        if (!final && streamBuffer === lastEditedText) return;

        const raw = streamBuffer.slice(0, TELEGRAM_MAX_LENGTH);
        const text = final ? toTelegramMd(raw) : raw;
        lastEditedText = text;
        try {
          if (streamMsgId) {
            if (final) {
              await this.bot.api.editMessageText(chatId, streamMsgId, text, { parse_mode: "Markdown" })
                .catch((err) => {
                  if (isNotModified(err)) return;
                  log.telegram.warn({ chatId, err: err.message }, "markdown edit failed, retrying plain");
                  return this.bot.api.editMessageText(chatId, streamMsgId!, raw).catch((err2) => {
                    if (!isNotModified(err2)) log.telegram.error({ chatId, err: err2.message }, "plain edit also failed");
                  });
                });
            } else {
              await this.bot.api.editMessageText(chatId, streamMsgId, text).catch(() => {});
            }
          } else {
            const sent = await this.bot.api.sendMessage(chatId, text);
            streamMsgId = sent.message_id;
          }
        } catch (err: any) {
          log.telegram.error({ chatId, err: err.message }, "flushStream failed");
        }
      };

      /** Split: finalize current message and start a new one. */
      const splitStream = async () => {
        await flushStream(true);
        streamMsgId = null;
        streamBuffer = "";
        lastEditedText = "";
      };

      const scheduleFlush = () => {
        if (debounceTimer) return;
        debounceTimer = setTimeout(() => { debounceTimer = null; flushStream(); }, debounceMs());
      };

      notificationListener = async (_method: string, params: any) => {
        const u = params.update;
        if (!u) return;

        const toolName = parser.toolCall(u);
        if (toolName) {
          if (streamBuffer && streamMsgId) {
            await flushStream(true);
            streamMsgId = null;
            streamBuffer = "";
            lastEditedText = "";
          }
          toolNames.push(escapeMd(toolName));
          const toolText = toolNames.slice(-6).map((t) => `⚙️ _${t}_`).join("\n");
          if (toolMsgId) {
            this.bot.api.editMessageText(chatId, toolMsgId, toolText, { parse_mode: "Markdown" }).catch(() => {});
          } else {
            this.bot.api.sendMessage(chatId, toolText, { parse_mode: "Markdown" })
              .then((m) => { toolMsgId = m.message_id; })
              .catch(() => {});
          }
          return;
        }

        const toolUpdate = parser.toolCallUpdate(u);
        if (toolUpdate && toolMsgId && (toolUpdate.status === "completed" || toolUpdate.status === "failed")) {
          const icon = toolUpdate.status === "completed" ? "✅" : "❌";
          const last = toolNames[toolNames.length - 1] || "";
          const prev = toolNames.slice(-6, -1).map((t) => `⚙️ _${t}_`);
          const toolText = [...prev, `${icon} _${last}_`].join("\n");
          this.bot.api.editMessageText(chatId, toolMsgId, toolText, { parse_mode: "Markdown" }).catch(() => {});
          return;
        }

        const chunk = parser.messageChunk(u);
        if (chunk !== null) {
          if (toolMsgId) {
            this.bot.api.deleteMessage(chatId, toolMsgId).catch(() => {});
            toolMsgId = null;
            toolNames.length = 0;
          }
          streamBuffer += chunk;
          totalStreamedChars += chunk.length;
          // Split into a new message when buffer gets large
          if (streamBuffer.length > SPLIT_THRESHOLD && streamMsgId) {
            splitStream();
          } else {
            scheduleFlush();
          }
        }
      };

      turnListener = async (_text: string) => {
        log.telegram.debug({ chatId, streamMsgId, bufferLen: streamBuffer.length }, "turn end");
        if (streamBuffer) {
          await flushStream(true);
          responseSentViaStream = true;
        }
        streamMsgId = null;
        streamBuffer = "";
        lastEditedText = "";
        if (toolMsgId) {
          this.bot.api.deleteMessage(chatId, toolMsgId).catch(() => {});
          toolMsgId = null;
          toolNames.length = 0;
        }
      };

      acp.on("notification", notificationListener);
      acp.on("turn_message", turnListener);

      const response = await acp.prompt(prompt);

      if (toolMsgId) {
        this.bot.api.deleteMessage(chatId, toolMsgId).catch(() => {});
      }

      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }

      if (!responseSentViaStream) {
        const finalText = response || "_(no response)_";

        log.telegram.debug({ chatId, totalStreamedChars, streamMsgId, bufferLen: streamBuffer.length }, "final send decision");

        if (totalStreamedChars > 0) {
          if (streamMsgId && streamBuffer) {
            log.telegram.debug({ chatId, streamMsgId }, "final edit of streamed message");
            const final = toTelegramMd(streamBuffer.slice(0, TELEGRAM_MAX_LENGTH));
            await this.bot.api.editMessageText(chatId, streamMsgId, final, { parse_mode: "Markdown" })
              .catch((err) => {
                if (isNotModified(err)) return;
                log.telegram.warn({ chatId, err: err.message }, "final markdown edit failed, retrying plain");
                return this.bot.api.editMessageText(chatId, streamMsgId!, streamBuffer.slice(0, TELEGRAM_MAX_LENGTH))
                  .catch((err2) => { if (!isNotModified(err2)) log.telegram.error({ chatId, err: err2.message }, "final plain edit also failed"); });
              });
          } else {
            log.telegram.debug({ chatId }, "streamed but no msgId, sending full response");
            await this.sendResponse(chatId, finalText);
          }
        } else {
          log.telegram.debug({ chatId, len: finalText.length }, "no streaming, sending full response");
          await this.sendResponse(chatId, finalText);
        }
      } else {
        log.telegram.debug({ chatId }, "response already sent via stream, skipping sendResponse");
      }

      log.telegram.info({ chatId, userId, preview: (response || "").slice(0, 100) }, "response sent");
    } catch (err: any) {
      log.telegram.error({ err, chatId }, "message handling failed");
      // Kill the dead client so the next message spawns a fresh one
      if (err.message?.includes("Timeout") || err.message?.includes("exited")) {
        log.telegram.warn({ chatId }, "recycling dead client");
        this.pool.kill(chatId);
      }
      await ctx.reply(`❌ Error: ${err.message}`);
    } finally {
      // Clean up listeners to prevent leaks
      if (acpInstance) {
        if (notificationListener) acpInstance.removeListener("notification", notificationListener);
        if (turnListener) acpInstance.removeListener("turn_message", turnListener);
      }
      // Always clear typing interval
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
    const parts: string[] = [];
    let remaining = toTelegramMd(text);

    while (remaining.length > TELEGRAM_MAX_LENGTH) {
      let splitAt = remaining.lastIndexOf("\n\n", TELEGRAM_MAX_LENGTH);
      if (splitAt === -1) splitAt = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
      if (splitAt === -1) splitAt = TELEGRAM_MAX_LENGTH;
      parts.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    parts.push(remaining);

    for (const part of parts) {
      try {
        await this.bot.api.sendMessage(chatId, part, { parse_mode: "Markdown" });
      } catch {
        try {
          await this.bot.api.sendMessage(chatId, part, { parse_mode: "HTML" });
        } catch {
          log.telegram.warn("markdown and HTML parse failed, sending as plain text");
          await this.bot.api.sendMessage(chatId, part);
        }
      }
    }
  }
}
