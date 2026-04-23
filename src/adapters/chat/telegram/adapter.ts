/**
 * Telegram Adapter — connects Telegram Bot API to the ACP client via grammy.
 */

import { Bot, type Context, InputFile } from "grammy";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AcpPool } from "../../../acp/pool.js";
import { log } from "../../../utils/logger.js";

const TELEGRAM_MAX_LENGTH = 4096;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

export class TelegramAdapter {
  readonly bot: Bot;
  private pool: AcpPool;
  private allowedUsers: Set<string>;
  private processing = new Set<string>();
  private activeCtx = new Map<number, { chatId: number; messageId: number; replyToMessageId?: number }>();

  /** Returns the context for a specific chat (used by tools). */
  getActiveContext(chatId?: number): { chatId: number; messageId: number; replyToMessageId?: number } | null {
    if (chatId) return this.activeCtx.get(chatId) ?? null;
    const first = this.activeCtx.values().next();
    return first.done ? null : first.value;
  }

  constructor(token: string, pool: AcpPool) {
    this.bot = new Bot(token);
    this.pool = pool;
    this.allowedUsers = new Set(
      (process.env.ALLOWED_USERS || "")
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
      await ctx.reply("⏳ Still working on your last message...");
      return;
    }

    this.processing.add(userId);
    log.telegram.info({ chatId, userId, preview: text.slice(0, 80) || (hasPhoto ? "[photo]" : "[document]") }, "message received");

    try {
      this.activeCtx.set(chatId, {
        chatId,
        messageId: msg.message_id,
        replyToMessageId: msg.reply_to_message?.message_id,
      });

      await ctx.replyWithChatAction("typing");
      const typingInterval = setInterval(
        () => ctx.replyWithChatAction("typing").catch(() => {}),
        4000
      );

      const prompt = await this.buildPrompt(ctx, text);
      const acp = await this.pool.get(chatId);
      const response = await acp.prompt(prompt);
      clearInterval(typingInterval);

      await this.sendResponse(chatId, response || "_(no response)_");
      log.telegram.info({ chatId, userId, preview: (response || "").slice(0, 100) }, "response sent");
    } catch (err: any) {
      log.telegram.error({ err, chatId }, "message handling failed");
      await ctx.reply(`❌ Error: ${err.message}`);
    } finally {
      this.activeCtx.delete(chatId);
      this.processing.delete(userId);
    }
  }

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
    let remaining = text;

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
