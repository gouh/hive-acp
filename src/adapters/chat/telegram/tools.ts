/**
 * Telegram tool category — tools exposed via MCP for Telegram interactions.
 *
 * send_file uses the ChatAdapter interface (platform-agnostic).
 * react requires direct Telegram bot access (platform-specific).
 */

import type { ToolCategory } from "../../../mcp/types.js";
import type { ChatAdapter } from "../types.js";
import type { TelegramAdapter } from "./adapter.js";
import fs from "node:fs";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif"]);

export function createTelegramTools(adapter: TelegramAdapter, workspace: string): ToolCategory {
  const chat: ChatAdapter = adapter;

  return {
    name: "telegram",
    tools: [
      {
        name: "telegram_send_file",
        description:
          "Send a file from the workspace to the user's active chat. " +
          "Use when the user asks to receive a file, document, image, or export.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute or workspace-relative path to the file" },
            caption: { type: "string", description: "Optional caption to accompany the file" },
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
            emoji: { type: "string", description: "A single emoji to react with (e.g. 👍, 🔥, ❤️, 🎉, 😂, 🤔, 👀, ✅)" },
            message_id: { type: "number", description: "The Telegram message_id to react to. If omitted, reacts to the user's current message." },
          },
          required: ["emoji"],
        },
      },
    ],

    async execute(toolName: string, args: any): Promise<string> {
      const ctx = chat.getActiveContext();
      if (!ctx) throw new Error("No active chat");

      switch (toolName) {
        case "telegram_send_file": {
          const filePath = path.isAbsolute(args.file_path)
            ? args.file_path
            : path.join(workspace, args.file_path);

          if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

          const ext = path.extname(filePath).toLowerCase();
          if (IMAGE_EXTENSIONS.has(ext)) {
            await chat.sendPhoto(ctx.chatId, filePath, args.caption);
          } else {
            await chat.sendFile(ctx.chatId, filePath, args.caption);
          }

          return `✅ Sent ${path.basename(filePath)} to chat`;
        }

        case "telegram_react": {
          // Platform-specific: requires direct Telegram bot access
          const targetId = args.message_id ?? ctx.replyToMessageId ?? ctx.messageId;
          if (!targetId) throw new Error("No message to react to");

          await adapter.bot.api.setMessageReaction(ctx.chatId, targetId, [
            { type: "emoji", emoji: args.emoji },
          ]);

          return `✅ Reacted with ${args.emoji} to message ${targetId}`;
        }

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    },
  };
}
