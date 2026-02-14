import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CronRunRecord } from "./types.js";

export class CronRunLog {
  constructor(private readonly runsDir: string) {}

  async append(jobId: string, record: CronRunRecord): Promise<void> {
    const file = join(this.runsDir, `${jobId}.jsonl`);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  }
}

