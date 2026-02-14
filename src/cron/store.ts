import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CronJob } from "./types.js";

export class CronStore {
  constructor(private readonly jobsPath: string) {}

  async loadJobs(): Promise<CronJob[]> {
    try {
      const raw = await readFile(this.jobsPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as CronJob[];
    } catch {
      return [];
    }
  }

  async saveJobs(jobs: CronJob[]): Promise<void> {
    await mkdir(dirname(this.jobsPath), { recursive: true });
    await writeFile(this.jobsPath, JSON.stringify(jobs, null, 2), "utf8");
  }
}

