export type CronJobTarget = {
  guildId: string;
  channelId: string;
  threadId?: string | null;
};

export type CronJobStatus = "idle" | "queued" | "running" | "ok" | "error" | "skipped";

export type CronJobState = {
  nextRunAtMs: number;
  lastRunAtMs: number;
  lastStatus: CronJobStatus;
  lastError?: string;
  lastDurationMs?: number;
};

export type CronJob = {
  id: string;
  schedule: string;
  target: CronJobTarget;
  prompt: string;
  systemPrompt?: string;
  createdAtMs: number;
  updatedAtMs: number;
  state: CronJobState;
};

export type CronJobDraft = {
  schedule: string;
  prompt: string;
  systemPrompt?: string;
};

export type CronRunRecord = {
  ts: number;
  runId: string;
  jobId: string;
  runAtMs: number;
  status: "queued" | "ok" | "error" | "skipped";
  durationMs?: number;
  error?: string;
  summary?: string;
  sessionKey: string;
  nextRunAtMs: number;
};

