import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

type SessionRecord = {
  sessionID?: string;
  updatedAt: number;
  model?: string;
};

type SessionStoreFile = Record<string, SessionRecord>;

export const SESSION_STORE_PATH = join(homedir(), ".opencodebot", "sessions.json");

export class SessionStore {
  private data: SessionStoreFile = {};

  constructor(private readonly path = SESSION_STORE_PATH) {}

  async load() {
    try {
      const raw = await readFile(this.path, "utf8");
      this.data = JSON.parse(raw) as SessionStoreFile;
    } catch {
      this.data = {};
    }
  }

  get(channelKey: string): SessionRecord | undefined {
    return this.data[channelKey];
  }

  async set(channelKey: string, sessionID: string) {
    const existing = this.data[channelKey];
    this.data[channelKey] = { sessionID, updatedAt: Date.now(), model: existing?.model };
    await this.flush();
  }

  async setModel(channelKey: string, model?: string) {
    const existing = this.data[channelKey];
    if (!existing) {
      this.data[channelKey] = { updatedAt: Date.now(), model };
    } else {
      existing.model = model;
      existing.updatedAt = Date.now();
    }
    await this.flush();
  }

  private async flush() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.data, null, 2), "utf8");
  }
}
