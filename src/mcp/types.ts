/**
 * Tool category interface — each adapter registers its tools here.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface ToolCategory {
  /** Category name (e.g. "telegram", "slack") */
  name: string;
  /** Tool definitions for MCP tools/list */
  tools: ToolDefinition[];
  /** Execute a tool by name */
  execute(toolName: string, args: any): Promise<string>;
}
