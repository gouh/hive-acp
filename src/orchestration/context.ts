/**
 * Orchestrator Context Service
 *
 * Builds dynamic context injected into every user message to the orchestrator.
 * Ensures the orchestrator always has fresh state even after LLM context compaction.
 */

import type { TripleStore } from "../memory/store.js";
import type { JobManager } from "../orchestration/job-manager.js";
import type { ProviderRegistry } from "../acp/registry.js";
import type { Job } from "../orchestration/types.js";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function formatJob(job: Job): string {
  const status = job.status === "done" ? "✅" : job.status === "failed" ? "❌" : job.status === "running" ? "⏳" : "⏸️";
  const tasks = job.tasks.map((t) => {
    const icon = t.status === "done" ? "✅" : t.status === "failed" ? "❌" : t.status === "running" ? "⏳" : "⏸️";
    const result = t.result ? ` → ${t.result.slice(0, 150)}` : t.error ? ` → ERROR: ${t.error.slice(0, 100)}` : "";
    return `  ${icon} ${t.agent}: ${t.task.slice(0, 100)}${result}`;
  }).join("\n");
  return `${status} Job ${job.id} (${timeAgo(job.createdAt)}):\n${tasks}`;
}

export function buildOrchestratorContext(
  chatId: number,
  registry: ProviderRegistry,
  jobManager: JobManager,
  store: TripleStore,
): string | null {
  const sections: string[] = [];

  // 1. Available agents
  const agents = registry.listAgents();
  if (agents.length > 0) {
    const list = agents.map((a) => `- ${a.name} (${a.provider}): ${a.description}`).join("\n");
    sections.push(`## Available Agents\n${list}`);
  }

  // 2. Recent jobs for this chat
  const jobs = jobManager.getRecentJobs(chatId, 5);
  if (jobs.length > 0) {
    const jobLines = jobs.map(formatJob).join("\n\n");
    sections.push(`## Recent Jobs\n${jobLines}`);
  }

  // 3. Knowledge graph
  const graph = store.toContext();
  if (graph) {
    sections.push(`## Known Facts\n${graph}`);
  }

  if (sections.length === 0) return null;

  return `[ORCHESTRATOR CONTEXT]\n${sections.join("\n\n")}\n[END CONTEXT]`;
}
