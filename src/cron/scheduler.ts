import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { CronRunLog } from "./run-log.js";
import { CronStore } from "./store.js";
import type { CronJob, CronJobDraft, CronJobState, CronJobTarget, CronRunRecord } from "./types.js";

const DEFAULT_ROOT = join(homedir(), ".opencodebot", "cron");
const DEFAULT_JOBS_PATH = join(DEFAULT_ROOT, "jobs.json");
const DEFAULT_RUNS_DIR = join(DEFAULT_ROOT, "runs");

type RunRequest = { runId: string; jobId: string; runAtMs: number };

type CronSchedulerOptions = {
  enabled: boolean;
  maxConcurrentRuns: number;
  catchUpWindowMinutes: number;
  maxCatchUpRunsPerJob: number;
  defaultTimeoutMs: number;
  logLevel?: "info" | "debug";
  jobsPath?: string;
  runsDir?: string;
  runPrompt: (input: { channelKey: string; prompt: string; systemPrompt?: string }) => Promise<string>;
  notify: (target: CronJobTarget, text: string) => Promise<void>;
};

function targetToSessionKey(target: CronJobTarget): string {
  return `${target.guildId}:${target.threadId || target.channelId}`;
}

function nowMs() {
  return Date.now();
}

function nextRunAtMs(schedule: string, fromMs: number): number {
  return CronExpressionParser.parse(schedule, { currentDate: new Date(fromMs) }).next().getTime();
}

function isSupportedSchedule(schedule: string): boolean {
  const trimmed = schedule.trim();
  if (trimmed.startsWith("@")) return false;
  if (trimmed.split(/\s+/).length !== 5) return false;
  try {
    CronExpressionParser.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function convertAtScheduleToDailyCron(schedule: string): string | undefined {
  const match = schedule.trim().match(/^@\s*(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || "0");
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return `${utcDate.getMinutes()} ${utcDate.getHours()} * * *`;
}

function buildExecutionSystemPrompt(jobSystemPrompt?: string): string {
  const base = [
    "你正在执行一个“已触发”的定时任务。",
    "这不是任务创建/修改/删除请求。",
    "禁止管理 cron 任务：不要调用 cron skill，不要读写 ~/.opencodebot/cron/jobs.json 或 runs 目录。",
    "如果任务只是提醒且无需工具操作，直接输出给用户的提醒内容即可。",
    "输出简洁、直接的结果。",
  ].join("\n");
  if (!jobSystemPrompt) return base;
  return `${base}\n\n附加任务规则:\n${jobSystemPrompt}`;
}

function buildExecutionPrompt(job: CronJob, runAtMs: number): string {
  return [
    "[cron-trigger]",
    `jobId: ${job.id}`,
    `schedule: ${job.schedule}`,
    `runAt: ${new Date(runAtMs).toISOString()}`,
    "task:",
    job.prompt,
  ].join("\n");
}

function validateDraft(input: CronJobDraft): CronJobDraft {
  const schedule = input.schedule?.trim();
  const prompt = input.prompt?.trim();
  const systemPrompt = input.systemPrompt?.trim() || undefined;
  if (!schedule) throw new Error("draft.schedule is required");
  if (!prompt) throw new Error("draft.prompt is required");
  if (prompt.length > 4000) throw new Error("draft.prompt too long");
  CronExpressionParser.parse(schedule);
  return { schedule, prompt, systemPrompt };
}

export class CronScheduler {
  private readonly store: CronStore;
  private readonly runLog: CronRunLog;
  private readonly jobs = new Map<string, CronJob>();
  private readonly queue: RunRequest[] = [];
  private readonly runningJobs = new Set<string>();
  private timer?: NodeJS.Timeout;
  private activeRuns = 0;
  private lastReloadAtMs = 0;

  constructor(private readonly options: CronSchedulerOptions) {
    this.store = new CronStore(options.jobsPath || DEFAULT_JOBS_PATH);
    this.runLog = new CronRunLog(options.runsDir || DEFAULT_RUNS_DIR);
  }

  async start(): Promise<void> {
    if (!this.options.enabled) {
      console.log("[opencodebot] cron disabled");
      return;
    }
    await this.reloadJobsFromStore();
    await this.bootstrapCatchUp();
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
    console.log(`[opencodebot] cron started jobs=${this.jobs.size}`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  get enabled() {
    return this.options.enabled;
  }

  async reconcileJobSchedules(): Promise<{ converted: Array<{ id: string; from: string; to: string }>; invalid: string[] }> {
    const loaded = await this.store.loadJobs();
    const converted: Array<{ id: string; from: string; to: string }> = [];
    const invalid: string[] = [];
    console.log(`[opencodebot] cron reconcile start jobs=${loaded.length}`);
    let changed = false;
    for (const job of loaded) {
      if (!job || typeof job.id !== "string" || typeof job.schedule !== "string") continue;
      if (isSupportedSchedule(job.schedule)) continue;
      const convertedSchedule = convertAtScheduleToDailyCron(job.schedule);
      if (convertedSchedule && isSupportedSchedule(convertedSchedule)) {
        converted.push({ id: job.id, from: job.schedule, to: convertedSchedule });
        job.schedule = convertedSchedule;
        job.updatedAtMs = nowMs();
        job.state = {
          ...(job.state || { lastRunAtMs: 0, lastStatus: "idle" }),
          nextRunAtMs: 0,
        };
        changed = true;
      } else {
        invalid.push(job.id);
      }
    }
    if (changed) {
      await this.store.saveJobs(loaded);
      this.lastReloadAtMs = 0;
      for (const item of converted) {
        console.log(`[opencodebot] cron schedule converted job=${item.id} from="${item.from}" to="${item.to}"`);
      }
    }
    if (invalid.length) {
      for (const id of invalid) {
        console.warn(`[opencodebot] cron skip invalid schedule job=${id}`);
      }
      console.warn(`[opencodebot] cron schedule invalid jobs=${invalid.join(",")}`);
    }
    console.log(`[opencodebot] cron reconcile done converted=${converted.length} invalid=${invalid.length}`);
    return { converted, invalid };
  }

  async addDraft(target: CronJobTarget, draftInput: CronJobDraft): Promise<CronJob> {
    if (!this.options.enabled) {
      throw new Error("Cron is disabled by config");
    }
    const draft = validateDraft(draftInput);
    const createdAt = nowMs();
    const job: CronJob = {
      id: `job_${createdAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      schedule: draft.schedule,
      target,
      prompt: draft.prompt,
      systemPrompt: draft.systemPrompt,
      createdAtMs: createdAt,
      updatedAtMs: createdAt,
      state: {
        nextRunAtMs: nextRunAtMs(draft.schedule, createdAt),
        lastRunAtMs: 0,
        lastStatus: "idle",
      },
    };
    this.jobs.set(job.id, job);
    await this.persistJobs();
    return job;
  }

  private async bootstrapCatchUp(): Promise<void> {
    const now = nowMs();
    const minRunAt = now - this.options.catchUpWindowMinutes * 60_000;
    for (const job of this.jobs.values()) {
      if (!job.state?.nextRunAtMs || job.state.nextRunAtMs <= 0) {
        job.state = {
          nextRunAtMs: nextRunAtMs(job.schedule, now),
          lastRunAtMs: 0,
          lastStatus: "idle",
        };
        console.log(`[opencodebot] cron init next run job=${job.id} nextRunAtMs=${job.state.nextRunAtMs}`);
      }
      let cursor = job.state.nextRunAtMs;
      let catchUpCount = 0;
      while (cursor <= now && catchUpCount < this.options.maxCatchUpRunsPerJob) {
        if (cursor >= minRunAt) {
          await this.enqueue(job, cursor);
          catchUpCount++;
        }
        cursor = nextRunAtMs(job.schedule, cursor);
      }
      job.state.nextRunAtMs = cursor;
      job.updatedAtMs = now;
    }
  }

  private async tick(): Promise<void> {
    await this.reloadJobsFromStore();
    const now = nowMs();
    let changed = false;
    for (const job of this.jobs.values()) {
      while (job.state.nextRunAtMs <= now) {
        await this.enqueue(job, job.state.nextRunAtMs);
        job.state.nextRunAtMs = nextRunAtMs(job.schedule, job.state.nextRunAtMs);
        job.updatedAtMs = now;
        changed = true;
      }
    }
    if (changed) {
      await this.persistJobs();
    }
    await this.dispatch();
  }

  private async enqueue(job: CronJob, runAtMs: number): Promise<void> {
    const runId = randomUUID();
    this.queue.push({ jobId: job.id, runAtMs, runId });
    this.queue.sort((a, b) => (a.runAtMs === b.runAtMs ? a.jobId.localeCompare(b.jobId) : a.runAtMs - b.runAtMs));
    const record: CronRunRecord = {
      ts: nowMs(),
      runId,
      jobId: job.id,
      runAtMs,
      status: "queued",
      sessionKey: targetToSessionKey(job.target),
      nextRunAtMs: job.state.nextRunAtMs,
    };
    await this.runLog.append(job.id, record);
    console.log(`[opencodebot] cron enqueued job=${job.id} runAtMs=${runAtMs} queueSize=${this.queue.length}`);
  }

  private async dispatch(): Promise<void> {
    if (this.activeRuns >= this.options.maxConcurrentRuns) return;
    let idx = 0;
    while (idx < this.queue.length && this.activeRuns < this.options.maxConcurrentRuns) {
      const req = this.queue[idx];
      if (this.runningJobs.has(req.jobId)) {
        idx++;
        continue;
      }
      this.queue.splice(idx, 1);
      void this.execute(req);
    }
  }

  private async execute(req: RunRequest): Promise<void> {
    const job = this.jobs.get(req.jobId);
    if (!job) return;
    this.activeRuns++;
    this.runningJobs.add(job.id);
    const startedAt = nowMs();
    const channelKey = targetToSessionKey(job.target);
    let status: "ok" | "error" | "skipped" = "ok";
    let output = "";
    let errorText: string | undefined;
    try {
      console.log(`[opencodebot] cron executing job=${job.id} runId=${req.runId} runAtMs=${req.runAtMs}`);
      job.state.lastStatus = "running";
      job.updatedAtMs = startedAt;
      await this.persistJobs();
      const executionPrompt = buildExecutionPrompt(job, req.runAtMs);
      const executionSystemPrompt = buildExecutionSystemPrompt(job.systemPrompt);
      output = await this.withTimeout(
        this.options.runPrompt({ channelKey, prompt: executionPrompt, systemPrompt: executionSystemPrompt }),
        this.options.defaultTimeoutMs,
      );
      await this.options.notify(job.target, `⏰ [${job.id}] 定时任务执行完成\n\n${output}`.trim());
      job.state.lastStatus = "ok";
    } catch (error) {
      status = "error";
      errorText = error instanceof Error ? error.message : String(error);
      job.state.lastStatus = "error";
      job.state.lastError = errorText;
      await this.options.notify(job.target, `⏰ [${job.id}] 定时任务执行失败\n\n${errorText}`);
    } finally {
      const endedAt = nowMs();
      const durationMs = endedAt - startedAt;
      job.state.lastRunAtMs = req.runAtMs;
      job.state.lastDurationMs = durationMs;
      job.updatedAtMs = endedAt;
      await this.persistJobs();
      await this.runLog.append(job.id, {
        ts: endedAt,
        runId: req.runId,
        jobId: job.id,
        runAtMs: req.runAtMs,
        status,
        durationMs,
        error: errorText,
        summary: output.slice(0, 500),
        sessionKey: channelKey,
        nextRunAtMs: job.state.nextRunAtMs,
      });
      console.log(
        `[opencodebot] cron finished job=${job.id} runId=${req.runId} status=${status} durationMs=${durationMs}`,
      );
      this.runningJobs.delete(job.id);
      this.activeRuns--;
      await this.dispatch();
    }
  }

  private async persistJobs(): Promise<void> {
    await this.store.saveJobs(Array.from(this.jobs.values()));
  }

  private async reloadJobsFromStore(): Promise<void> {
    const now = nowMs();
    if (now - this.lastReloadAtMs < 2000) return;
    this.lastReloadAtMs = now;
    const loaded = await this.store.loadJobs();
    const next = new Map<string, CronJob>();
    for (const raw of loaded) {
      if (!raw || typeof raw.id !== "string" || typeof raw.schedule !== "string") continue;
      if (!raw.target?.guildId || !raw.target?.channelId || typeof raw.prompt !== "string") continue;
      if (!isSupportedSchedule(raw.schedule)) {
        console.warn(`[opencodebot] cron skip invalid schedule job=${raw.id}`);
        continue;
      }
      const existing = this.jobs.get(raw.id);
      const scheduleChanged = !!existing && existing.schedule !== raw.schedule;
      const state = this.normalizeState(raw.state, raw.schedule, existing?.state, now, raw.id, scheduleChanged);

      // Detect stale nextRunAtMs: if file has a future nextRunAtMs but it doesn't
      // match what this schedule would produce, force recalc (covers manual edits
      // across restarts where we have no in-memory baseline to detect the change).
      if (!scheduleChanged && state.nextRunAtMs > now) {
        try {
          const expectedNext = nextRunAtMs(raw.schedule, now);
          if (state.nextRunAtMs !== expectedNext) {
            if (this.options.logLevel === "debug") {
              console.log(
                `[opencodebot] cron stale nextRunAtMs detected job=${raw.id} stored=${state.nextRunAtMs} expected=${expectedNext}, recalculating`,
              );
            }
            state.nextRunAtMs = expectedNext;
          }
        } catch { /* schedule parse error handled above */ }
      }

      if (scheduleChanged) {
        console.log(
          `[opencodebot] cron schedule reloaded job=${raw.id} from="${existing?.schedule}" to="${raw.schedule}" nextRunAtMs=${state.nextRunAtMs}`,
        );
      }
      next.set(raw.id, {
        ...raw,
        updatedAtMs: raw.updatedAtMs || now,
        createdAtMs: raw.createdAtMs || now,
        state,
      });
    }
    const removed = new Set(this.jobs.keys());
    for (const id of next.keys()) removed.delete(id);
    if (removed.size > 0) {
      this.queue.splice(0, this.queue.length, ...this.queue.filter((item) => !removed.has(item.jobId)));
    }
    this.jobs.clear();
    for (const [id, job] of next) {
      this.jobs.set(id, job);
    }
  }

  private normalizeState(
    state: CronJobState | undefined,
    schedule: string,
    fallback: CronJobState | undefined,
    now: number,
    jobID: string,
    scheduleChanged: boolean,
  ): CronJobState {
    if (scheduleChanged) {
      return {
        ...(state || fallback || { lastRunAtMs: 0, lastStatus: "idle" }),
        lastStatus:
          (state || fallback)?.lastStatus === "running" ? "idle" : (state || fallback)?.lastStatus || "idle",
        nextRunAtMs: nextRunAtMs(schedule, now),
      };
    }
    if (state?.nextRunAtMs && state.nextRunAtMs > 0) {
      if (state.lastStatus === "running" && !this.runningJobs.has(jobID)) {
        return { ...state, lastStatus: "idle" };
      }
      return state;
    }
    if (fallback?.nextRunAtMs && fallback.nextRunAtMs > 0) {
      return fallback;
    }
    if (!state && !fallback) {
      return {
        nextRunAtMs: nextRunAtMs(schedule, now),
        lastRunAtMs: 0,
        lastStatus: "idle",
      };
    }
    return { ...(state || fallback)!, nextRunAtMs: nextRunAtMs(schedule, now) };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    const timeoutError = new Error(`Cron run timeout after ${timeoutMs}ms`);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
      });
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function parseCronDraftFromText(text: string): CronJobDraft | undefined {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const raw = (fenced || text).trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<CronJobDraft>;
    if (typeof parsed.schedule !== "string" || typeof parsed.prompt !== "string") return undefined;
    if (parsed.systemPrompt != null && typeof parsed.systemPrompt !== "string") return undefined;
    return {
      schedule: parsed.schedule,
      prompt: parsed.prompt,
      systemPrompt: parsed.systemPrompt,
    };
  } catch {
    return undefined;
  }
}

export function defaultCronOptions(config: {
  enabled?: boolean;
  maxConcurrentRuns?: number;
  catchUpWindowMinutes?: number;
  maxCatchUpRunsPerJob?: number;
  defaultTimeoutMs?: number;
  logLevel?: "info" | "debug";
}) {
  return {
    enabled: config.enabled === true,
    maxConcurrentRuns: Math.max(1, config.maxConcurrentRuns ?? 2),
    catchUpWindowMinutes: Math.max(1, config.catchUpWindowMinutes ?? 60),
    maxCatchUpRunsPerJob: Math.max(1, config.maxCatchUpRunsPerJob ?? 20),
    defaultTimeoutMs: Math.max(10_000, config.defaultTimeoutMs ?? 600_000),
    logLevel: config.logLevel ?? "info",
  };
}
