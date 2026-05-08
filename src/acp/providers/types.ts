/**
 * CLI Provider — abstraction for different ACP-compatible agent CLIs.
 */

export interface CliProvider {
  name: string;
  bin: string;
  args: string[];
  env?: Record<string, string>;
  capabilities: Record<string, any>;
  /** CLI flag to select an agent (e.g. "--agent"). If absent, agent selection via CLI is not supported. */
  agentFlag?: string;
  /** Map a vendor-specific extension notification to a session update, or null to ignore. */
  mapExtNotification?(method: string, params: Record<string, any>): Record<string, any> | null;
  /** Clean/shorten a tool title for display (e.g. strip paths, truncate). */
  cleanToolTitle?(raw: string): string;
}
