/**
 * Orchestration tool category — MCP tools for dispatching and managing subagent jobs.
 */

import type { ToolCategory } from "../mcp/types.js";
import type { JobManager } from "./job-manager.js";
import type { ProviderRegistry } from "../acp/registry.js";

export function createOrchestrationTools(jobManager: JobManager, registry: ProviderRegistry): ToolCategory {
  return {
    name: "orchestration",
    tools: [
      {
        name: "agent_list",
        description:
          "List available subagents with their names, descriptions, and provider. " +
          "Use this to decide which agent to dispatch a task to.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "agent_dispatch",
        description:
          "Dispatch tasks to subagents in parallel. Returns a job ID immediately. " +
          "Each task runs in an isolated agent process. Agents can be from different providers (kiro, opencode). " +
          "Use agent_list to see available agents, then agent_job to check results.",
        inputSchema: {
          type: "object",
          properties: {
            chatId: { type: "number", description: "Chat ID to associate the job with" },
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  agent: { type: "string", description: "Agent name from agent_list (e.g. 'hiveacp-coder', 'opencode-coder')" },
                  task: { type: "string", description: "Task instructions for the subagent" },
                },
                required: ["agent", "task"],
              },
              description: "List of tasks to run in parallel",
            },
          },
          required: ["chatId", "tasks"],
        },
      },
      {
        name: "agent_job",
        description:
          "Check the status and results of a dispatched job. " +
          "Returns task statuses and results for completed tasks.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Job ID returned by agent_dispatch" },
          },
          required: ["id"],
        },
      },
      {
        name: "agent_cancel",
        description: "Cancel a running job and all its pending tasks.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Job ID to cancel" },
          },
          required: ["id"],
        },
      },
    ],

    async execute(toolName: string, args: any): Promise<string> {
      switch (toolName) {
        case "agent_list": {
          const agents = registry.listAgents();
          if (agents.length === 0) return "No subagents registered";
          return agents.map((a) => `• **${a.name}** (${a.provider}): ${a.description}`).join("\n");
        }
        case "agent_dispatch": {
          const job = jobManager.dispatch(args.chatId, args.tasks);
          const taskList = job.tasks.map((t) => `  - ${t.agent}: ${t.task.slice(0, 80)}`).join("\n");
          return `✅ Job ${job.id} dispatched (${job.tasks.length} tasks)\n${taskList}`;
        }
        case "agent_job": {
          const job = jobManager.getJob(args.id);
          if (!job) return `❌ Job not found: ${args.id}`;
          const lines = [`📋 Job ${job.id} — ${job.status}`];
          for (const t of job.tasks) {
            const status = t.status === "done" ? "✅" : t.status === "failed" ? "❌" : t.status === "running" ? "⏳" : "⏸️";
            lines.push(`${status} ${t.agent}: ${t.status}`);
            if (t.result) lines.push(`   Result: ${t.result.slice(0, 4000)}`);
            if (t.error) lines.push(`   Error: ${t.error}`);
          }
          return lines.join("\n");
        }
        case "agent_cancel": {
          const ok = jobManager.cancel(args.id);
          return ok ? `✅ Job ${args.id} cancelled` : `❌ Job not found or already finished: ${args.id}`;
        }
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    },
  };
}
