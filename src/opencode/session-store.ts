import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

type SessionRecord = {
  sessionID?: string;
  updatedAt: number;
  model?: string;
};

type SessionStoreFile = {
  mainSessionID?: string;
  channels: Record<string, SessionRecord>;
};

export const SESSION_STORE_PATH = join(homedir(), ".opencodebot", "sessions.json");

export class SessionStore {
  private data: SessionStoreFile = { channels: {} };

  constructor(private readonly path = SESSION_STORE_PATH) {}

  async load() {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      // Migrate old format (flat Record) to new format with mainSessionID
      if (parsed && typeof parsed === "object" && !("channels" in parsed)) {
        this.data = { channels: parsed as Record<string, SessionRecord> };
      } else {
        this.data = parsed as SessionStoreFile;
        if (!this.data.channels) this.data.channels = {};
      }
    } catch {
      this.data = { channels: {} };
    }
  }

  getMainSessionID(): string | undefined {
    return this.data.mainSessionID;
  }

  async setMainSessionID(sessionID: string) {
    this.data.mainSessionID = sessionID;
    await this.flush();
  }

  get(channelKey: string): SessionRecord | undefined {
    return this.data.channels[channelKey];
  }

  async set(channelKey: string, sessionID: string) {
    const existing = this.data.channels[channelKey];
    this.data.channels[channelKey] = { sessionID, updatedAt: Date.now(), model: existing?.model };
    await this.flush();
  }

  async setModel(channelKey: string, model?: string) {
    const existing = this.data.channels[channelKey];
    if (!existing) {
      this.data.channels[channelKey] = { updatedAt: Date.now(), model };
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
