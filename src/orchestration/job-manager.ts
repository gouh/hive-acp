/**
 * JobManager — orchestrates ephemeral subagent tasks with an event bus.
 *
 * Spawns AcpClients for each task using the ProviderRegistry to resolve
 * the correct provider per agent. Runs tasks in parallel, extracts
 * triples on completion, and emits events for adapters to consume.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { AcpClient } from "../acp/client.js";
import type { ProviderRegistry } from "../acp/registry.js";
import type { TripleStore } from "../memory/store.js";
import { log } from "../utils/logger.js";
import type { Job, JobEvent, TaskEntry } from "./types.js";

export class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private clients = new Map<string, AcpClient>();

  constructor(
    private registry: ProviderRegistry,
    private store: TripleStore,
  ) {
    super();
  }

  dispatch(chatId: number, tasks: Array<{ agent: string; task: string }>): Job {
    const jobId = `j-${crypto.randomUUID().split("-")[0]}`;
    const entries: TaskEntry[] = tasks.map((t, i) => ({
      id: `${jobId}-${i}`,
      agent: t.agent,
      task: t.task,
      status: "pending",
    }));

    const job: Job = { id: jobId, chatId, status: "running", tasks: entries, createdAt: Date.now() };
    this.jobs.set(jobId, job);
    log.main.info({ jobId, chatId, count: tasks.length }, "job dispatched");

    for (const entry of entries) {
      this.runTask(job, entry);
    }

    return job;
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running") return false;

    for (const task of job.tasks) {
      if (task.status === "pending" || task.status === "running") {
        task.status = "cancelled";
        const client = this.clients.get(task.id);
        if (client) {
          client.stop();
          this.clients.delete(task.id);
        }
      }
    }

    job.status = "cancelled";
    job.finishedAt = Date.now();
    log.main.info({ jobId }, "job cancelled");
    return true;
  }

  private async runTask(job: Job, task: TaskEntry): Promise<void> {
    const provider = this.registry.resolve(task.agent);
    if (!provider) {
      task.status = "failed";
      task.error = `No provider found for agent "${task.agent}"`;
      task.finishedAt = Date.now();
      log.main.error({ jobId: job.id, taskId: task.id, agent: task.agent }, "no provider for agent");
      this.emit("event", { type: "task:failed", jobId: job.id, chatId: job.chatId, task } satisfies JobEvent);
      this.checkJobComplete(job);
      return;
    }

    task.status = "running";
    task.startedAt = Date.now();

    const client = new AcpClient(provider, task.agent);
    this.clients.set(task.id, client);

    try {
      await client.start();

      client.on("notification", (_method: string, params: any) => {
        this.emit("event", {
          type: "task:progress",
          jobId: job.id,
          chatId: job.chatId,
          task,
          detail: params.update,
          parser: provider.parser,
        } as JobEvent);
      });

      const graph = this.store.toContext();
      // If the provider doesn't support agent selection via CLI flag,
      // prepend the agent's instructions to the task prompt.
      const instructions = !provider.agentFlag ? this.registry.getInstructions(task.agent) : undefined;
      const parts = [
        instructions ? `[AGENT INSTRUCTIONS]\n${instructions}\n[END INSTRUCTIONS]` : "",
        graph ? `[KNOWLEDGE GRAPH]\n${graph}\n[END GRAPH]` : "",
        task.task,
      ].filter(Boolean);
      const taskText = parts.join("\n\n");

      const result = await client.prompt([{ type: "text", text: taskText }]);

      task.status = "done";
      task.result = result;
      task.finishedAt = Date.now();
      log.main.info({ jobId: job.id, taskId: task.id, agent: task.agent, provider: provider.name }, "task complete");

      this.emit("event", {
        type: "task:complete",
        jobId: job.id,
        chatId: job.chatId,
        task,
      } satisfies JobEvent);
    } catch (err: any) {
      task.status = "failed";
      task.error = err.message;
      task.finishedAt = Date.now();
      log.main.error({ jobId: job.id, taskId: task.id, err: err.message }, "task failed");

      this.emit("event", {
        type: "task:failed",
        jobId: job.id,
        chatId: job.chatId,
        task,
      } satisfies JobEvent);
    } finally {
      client.stop();
      this.clients.delete(task.id);
    }

    this.checkJobComplete(job);
  }

  private checkJobComplete(job: Job): void {
    const pending = job.tasks.some((t) => t.status === "pending" || t.status === "running");
    if (pending) return;

    const failed = job.tasks.some((t) => t.status === "failed");
    job.status = failed ? "failed" : "done";
    job.finishedAt = Date.now();

    log.main.info({ jobId: job.id, status: job.status }, "job complete");
    this.emit("event", {
      type: "job:complete",
      jobId: job.id,
      chatId: job.chatId,
      job,
    } satisfies JobEvent);
  }

  async stop(): Promise<void> {
    for (const [id, client] of this.clients) {
      client.stop();
      this.clients.delete(id);
    }
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.status = "cancelled";
        job.finishedAt = Date.now();
      }
    }
  }
}
