/**
 * CLI Provider — abstraction for different ACP-compatible agent CLIs.
 */

export interface CliProvider {
  name: string;
  bin: string;
  args: string[];
  env?: Record<string, string>;
  capabilities: Record<string, any>;
}
