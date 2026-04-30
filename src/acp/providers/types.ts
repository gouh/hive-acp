/**
 * CLI Provider — abstraction for different ACP-compatible agent CLIs.
 */

/** Classifies a session update notification from the agent. */
export interface ResponseParser {
  /** Returns the text chunk if this update is a message chunk, or null. */
  messageChunk(update: Record<string, any>): string | null;
  /** Returns the full message text if this update is a complete message, or null. */
  fullMessage(update: Record<string, any>): string | null;
  /** Returns true if this update signals a turn boundary (reset accumulators). */
  isTurnEnd(update: Record<string, any>): boolean;
  /** Returns the tool name/title if this update is a new tool call, or null. */
  toolCall(update: Record<string, any>): string | null;
  /** Returns { toolCallId, status, title? } if this is a tool call update, or null. */
  toolCallUpdate(update: Record<string, any>): { toolCallId: string; status: string; title?: string } | null;
  /** Returns true if this is a tool_call_chunk (incremental tool progress). */
  isToolCallChunk(update: Record<string, any>): boolean;
}

export interface CliProvider {
  name: string;
  bin: string;
  args: string[];
  env?: Record<string, string>;
  capabilities: Record<string, any>;
  parser: ResponseParser;
  /** CLI flag to select an agent (e.g. "--agent"). If absent, agent selection via CLI is not supported. */
  agentFlag?: string;
}
