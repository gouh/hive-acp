/**
 * OpenCode CLI provider — spawn config for opencode ACP.
 *
 * OpenCode follows the standard ACP spec with snake_case session updates.
 * It does not emit TurnEnd, so isTurnEnd always returns false.
 */

import type { CliProvider, ResponseParser } from "./types.js";

const opencodeParser: ResponseParser = {
  messageChunk(u) {
    if (u.sessionUpdate === "agent_message_chunk") {
      return u.content?.text ?? null;
    }
    return null;
  },
  fullMessage(u) {
    if (u.sessionUpdate === "agent_message") {
      return u.content?.text ?? null;
    }
    return null;
  },
  isTurnEnd() {
    return false;
  },
  toolCall(u) {
    if (u.sessionUpdate === "tool_call") {
      return u.title || u.toolName || null;
    }
    return null;
  },
  toolCallUpdate(u) {
    if (u.sessionUpdate === "tool_call_update") {
      return { toolCallId: u.toolCallId, status: u.status || "", title: u.title };
    }
    return null;
  },
  isToolCallChunk(u) {
    return u.sessionUpdate === "tool_call_chunk";
  },
};

export function opencodeProvider(): CliProvider {
  return {
    name: "opencode",
    bin: process.env.HIVE_OPENCODE_CLI_PATH || "opencode",
    args: ["acp"],
    capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    parser: opencodeParser,
  };
}
