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

export interface JobEvent {
  type: "task:complete" | "task:failed" | "task:tool" | "task:tool_update" | "job:complete";
  jobId: string;
  chatId: number;
  task?: TaskEntry;
  job?: Job;
  /** For task:tool — the tool name. */
  toolName?: string;
  /** For task:tool_update — the tool status. */
  toolStatus?: string;
}
