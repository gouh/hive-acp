/**
 * Telegram tool category — tools exposed via MCP for Telegram interactions.
 */

import type { ToolCategory } from "../../../mcp/types.js";
import type { TelegramAdapter } from "./adapter.js";
import fs from "node:fs";
import path from "node:path";

export function createTelegramTools(adapter: TelegramAdapter, workspace: string): ToolCategory {
  return {
    name: "telegram",
    tools: [
      {
        name: "telegram_send_file",
        description:
          "Send a file from the workspace to the user's active Telegram chat. " +
          "Use when the user asks to receive a file, document, image, or export.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Absolute or workspace-relative path to the file",
            },
            caption: {
              type: "string",
              description: "Optional caption to accompany the file",
            },
          },
          required: ["file_path"],
        },
      },
      {
        name: "telegram_react",
        description:
          "React to a Telegram message with an emoji. " +
          "IMPORTANT: When the user's prompt includes '[telegram: message_id=X]', " +
          "use that X as the message_id parameter to react to that message. " +
          "If '[replying_to: message_id=Z]' is present, use Z instead. " +
          "You can also react proactively: 👀 when reviewing, ✅ when done, 🔥 for excitement.",
        inputSchema: {
          type: "object",
          properties: {
            emoji: {
              type: "string",
              description: "A single emoji to react with (e.g. 👍, 🔥, ❤️, 🎉, 😂, 🤔, 👀, ✅)",
            },
            message_id: {
              type: "number",
              description: "The Telegram message_id to react to. If omitted, reacts to the user's current message.",
            },
          },
          required: ["emoji"],
        },
      },
    ],

    async execute(toolName: string, args: any): Promise<string> {
      const { bot } = adapter;
      if (!bot) throw new Error("Bot not initialized");
      const ctx = adapter.getActiveContext();
      if (!ctx) throw new Error("No active Telegram chat");

      switch (toolName) {
        case "telegram_send_file": {
          const filePath = path.isAbsolute(args.file_path)
            ? args.file_path
            : path.join(workspace, args.file_path);

          if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

          const ext = path.extname(filePath).toLowerCase();
          const opts = args.caption ? { caption: args.caption } : {};

          if ([".jpg", ".jpeg", ".png", ".gif"].includes(ext)) {
            await bot.sendPhoto(ctx.chatId, filePath, opts);
          } else {
            await bot.sendDocument(ctx.chatId, filePath, opts);
          }

          return `✅ Sent ${path.basename(filePath)} to Telegram`;
        }

        case "telegram_react": {
          const targetId = args.message_id ?? ctx.replyToMessageId ?? ctx.messageId;
          if (!targetId) throw new Error("No message to react to");

          await bot.setMessageReaction(ctx.chatId, targetId, {
            reaction: JSON.stringify([{ type: "emoji", emoji: args.emoji }]),
          } as any);

          return `✅ Reacted with ${args.emoji} to message ${targetId}`;
        }

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    },
  };
}
