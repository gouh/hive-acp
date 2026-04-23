/**
 * Context tool category — manage conversation context persistence via MCP.
 */

import type { ToolCategory } from "../../mcp/types.js";
import type { AcpPool } from "../../acp/pool.js";
import type { TelegramAdapter } from "../chat/telegram/adapter.js";

export function createContextTools(pool: AcpPool, adapter: TelegramAdapter): ToolCategory {
  const getChatId = (): number => {
    const ctx = adapter.getActiveContext();
    if (!ctx) throw new Error("No active chat context");
    return ctx.chatId;
  };

  return {
    name: "context",
    tools: [
      {
        name: "context_save",
        description:
          "Save a conversation summary for the current chat. " +
          "Use when the user asks to save, persist, or remember the current context. " +
          "YOU must generate the summary and pass it as the 'summary' parameter.",
        inputSchema: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "Concise summary of the conversation including key topics, decisions, and pending tasks",
            },
          },
          required: ["summary"],
        },
      },
      {
        name: "context_clear",
        description:
          "Clear the saved conversation context for the current chat. " +
          "Use when the user asks to forget, reset, or start fresh.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "context_show",
        description:
          "Show the currently saved conversation summary for this chat. " +
          "Use when the user asks what context is saved or wants to review it.",
        inputSchema: { type: "object", properties: {} },
      },
    ],

    async execute(toolName: string, args: any): Promise<string> {
      const chatId = getChatId();

      switch (toolName) {
        case "context_save": {
          pool.saveSummary(chatId, args.summary);
          return `✅ Context saved for chat ${chatId}`;
        }
        case "context_clear": {
          const deleted = pool.deleteSummary(chatId);
          return deleted
            ? `✅ Context cleared for chat ${chatId}`
            : `ℹ️ No saved context found for chat ${chatId}`;
        }
        case "context_show": {
          const summary = pool.loadSummary(chatId);
          return summary || "ℹ️ No saved context for this chat";
        }
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    },
  };
}
