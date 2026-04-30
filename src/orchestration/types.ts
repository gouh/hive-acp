/**
 * Orchestration types — Job, TaskEntry, and event definitions.
 */

export type TaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface TaskEntry {
  id: string;
  agent: string;
  task: string;
  status: TaskStatus;
  result?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface Job {
  id: string;
  chatId: number;
  status: JobStatus;
  tasks: TaskEntry[];
  createdAt: number;
  finishedAt?: number;
}

import type { ResponseParser } from "../acp/providers/types.js";

export interface JobEvent {
  type: "task:complete" | "task:failed" | "task:progress" | "job:complete";
  jobId: string;
  chatId: number;
  task?: TaskEntry;
  job?: Job;
  /** For task:progress — the raw session update from the subagent. */
  detail?: Record<string, any>;
  /** For task:progress — the parser for the subagent's provider. */
  parser?: ResponseParser;
}
