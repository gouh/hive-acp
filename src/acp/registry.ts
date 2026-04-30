/**
 * ProviderRegistry — maps agent names to their CLI providers.
 *
 * Allows mixing providers (Kiro, OpenCode, etc.) so any orchestrator
 * can dispatch tasks to subagents regardless of their provider.
 */

import type { CliProvider } from "./providers/types.js";

export interface AgentEntry {
  name: string;
  description: string;
  provider: string;
}

export class ProviderRegistry {
  private providers = new Map<string, CliProvider>();
  private agents = new Map<string, { provider: string; description: string; instructions?: string }>();

  /** Register a provider by name. */
  addProvider(name: string, provider: CliProvider): void {
    this.providers.set(name, provider);
  }

  /** Register an agent and associate it with a provider. */
  addAgent(agentName: string, providerName: string, description = "", instructions?: string): void {
    this.agents.set(agentName, { provider: providerName, description, instructions });
  }

  /** Resolve the CliProvider for a given agent name. */
  resolve(agentName: string): CliProvider | null {
    const entry = this.agents.get(agentName);
    if (!entry) return null;
    return this.providers.get(entry.provider) ?? null;
  }

  /** List all registered agents with their provider and description. */
  listAgents(): AgentEntry[] {
    return Array.from(this.agents.entries()).map(([name, { provider, description }]) => ({
      name,
      description,
      provider,
    }));
  }

  /** Get a provider by name. */
  getProvider(name: string): CliProvider | null {
    return this.providers.get(name) ?? null;
  }

  /** Get instructions for an agent (used when the provider doesn't support agent selection). */
  getInstructions(agentName: string): string | undefined {
    return this.agents.get(agentName)?.instructions;
  }
}
