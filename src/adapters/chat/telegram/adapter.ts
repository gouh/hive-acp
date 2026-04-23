/**
 * Telegram Adapter — connects Telegram Bot API to the ACP client.
 */

import TelegramBot from "node-telegram-bot-api";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AcpPool } from "../../../acp/pool.js";
import { log } from "../../../utils/logger.js";

const TELEGRAM_MAX_LENGTH = 4096;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

export class TelegramAdapter {
  readonly bot: TelegramBot;
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
    this.bot = new TelegramBot(token, { polling: true });
    this.pool = pool;
    this.allowedUsers = new Set(
      (process.env.ALLOWED_USERS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    );
  }

  start(): void {
    this.bot.on("message", (msg) => this.onMessage(msg));
    this.bot.on("polling_error", (err) => {
      log.telegram.warn(`Polling error (will retry): ${err.message}`);
    });
    log.telegram.info("Listening for messages");
  }

  stop(): void {
    this.bot.stopPolling();
  }

  private async onMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = String(msg.from!.id);
    const text = msg.text?.trim() || msg.caption?.trim() || "";
    const hasPhoto = !!(msg.photo && msg.photo.length > 0);
    const hasDocument = !!msg.document;

    // Skip messages with no text and no media
    if (!text && !hasPhoto && !hasDocument) return;

    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId)) {
      await this.bot.sendMessage(chatId, "⛔ Not authorized.");
      return;
    }

    if (this.processing.has(userId)) {
      await this.bot.sendMessage(chatId, "⏳ Still working on your last message...");
      return;
    }

    this.processing.add(userId);
    log.telegram.info(`← ${userId}: ${text.slice(0, 80) || (hasPhoto ? "[photo]" : "[document]")}`);

    try {
      this.activeCtx.set(chatId, {
        chatId,
        messageId: msg.message_id,
        replyToMessageId: msg.reply_to_message?.message_id,
      });

      await this.bot.sendChatAction(chatId, "typing");
      const typingInterval = setInterval(
        () => this.bot.sendChatAction(chatId, "typing").catch(() => {}),
        4000
      );

      const prompt = await this.buildPrompt(msg, text);
      const acp = await this.pool.get(chatId);
      const response = await acp.prompt(prompt);
      clearInterval(typingInterval);

      await this.sendResponse(chatId, response || "_(no response)_");
      log.telegram.info(`→ ${userId}: ${(response || "").slice(0, 100)}`);
    } catch (err: any) {
      log.telegram.error(err.message);
      await this.bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    } finally {
      this.activeCtx.delete(chatId);
      this.processing.delete(userId);
    }
  }

  private async buildPrompt(
    msg: TelegramBot.Message,
    text: string,
  ): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
    const parts: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];

    // Metadata header
    let header = `[telegram: message_id=${msg.message_id}, chat_id=${msg.chat.id}]\n`;
    if (msg.reply_to_message) {
      const replyText = msg.reply_to_message.text || "(non-text message)";
      header += `[replying_to: message_id=${msg.reply_to_message.message_id}, text="${replyText.slice(0, 200)}"]\n`;
    }
    if (text) {
      header += text;
    }

    // Handle photo
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1]; // largest size
      const imageData = await this.downloadFileAsBase64(photo.file_id);
      if (imageData) {
        if (!text) header += "[The user sent a photo]";
        parts.push({ type: "text", text: header });
        parts.push({ type: "image", data: imageData.base64, mimeType: imageData.mimeType });
        return parts;
      }
    }

    // Handle document (images sent as files)
    if (msg.document) {
      const ext = path.extname(msg.document.file_name || "").toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        const imageData = await this.downloadFileAsBase64(msg.document.file_id);
        if (imageData) {
          if (!text) header += `[The user sent an image file: ${msg.document.file_name}]`;
          parts.push({ type: "text", text: header });
          parts.push({ type: "image", data: imageData.base64, mimeType: imageData.mimeType });
          return parts;
        }
      }
      // Non-image document — save to temp and mention in prompt
      const filePath = await this.downloadFileToTemp(msg.document.file_id, msg.document.file_name || "file");
      if (filePath) {
        if (!text) header += `[The user sent a file: ${msg.document.file_name}]`;
        header += `\n[File saved to: ${filePath}]`;
      }
    }

    parts.push({ type: "text", text: header });
    return parts;
  }

  private async downloadFileAsBase64(fileId: string): Promise<{ base64: string; mimeType: string } | null> {
    try {
      const fileLink = await this.bot.getFileLink(fileId);
      const response = await fetch(fileLink);
      const buffer = Buffer.from(await response.arrayBuffer());
      const ext = path.extname(new URL(fileLink).pathname).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
      };
      return { base64: buffer.toString("base64"), mimeType: mimeMap[ext] || "image/jpeg" };
    } catch (err: any) {
      log.telegram.error(`Failed to download file: ${err.message}`);
      return null;
    }
  }

  private async downloadFileToTemp(fileId: string, fileName: string): Promise<string | null> {
    try {
      const fileLink = await this.bot.getFileLink(fileId);
      const response = await fetch(fileLink);
      const buffer = Buffer.from(await response.arrayBuffer());
      const tmpPath = path.join(os.tmpdir(), `telegram-${Date.now()}-${fileName}`);
      fs.writeFileSync(tmpPath, buffer);
      return tmpPath;
    } catch (err: any) {
      log.telegram.error(`Failed to download file: ${err.message}`);
      return null;
    }
  }

  private async sendResponse(chatId: number, text: string): Promise<void> {
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
        await this.bot.sendMessage(chatId, part, { parse_mode: "Markdown" });
      } catch {
        try {
          await this.bot.sendMessage(chatId, part, { parse_mode: "HTML" });
        } catch {
          log.telegram.warn("Markdown and HTML parse failed, sending as plain text");
          await this.bot.sendMessage(chatId, part);
        }
      }
    }
  }
}
