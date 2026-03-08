import type { AppConfig } from "../config.js";
import { SessionStore } from "./session-store.js";
import { createManagedOpencodeServer, type ManagedServerCloseResult } from "./server-process.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PendingPrompt = {
  baselineMessageID?: string;
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
};

/** Tracks in-session message state for one session (main or channel child). */
type SessionMessageState = {
  pendingPrompts: PendingPrompt[];
  messageOrder: string[];
  messageTexts: Map<string, string>;
  latestMessageID?: string;
  lastActivityTime: number;
};

/** The single shared opencode server process for this bot instance. */
type SharedRuntime = {
  baseUrl: string;
  pid: number;
  close: () => Promise<ManagedServerCloseResult>;
  mainSessionID: string;
  abort: AbortController;
  streamTask: Promise<void>;
  /** sessionID → channelKey (or "main") — used by SSE dispatcher */
  sessionIndex: Map<string, string>;
  mainState: SessionMessageState;
  createdAt: number;
};

/** Per-channel entry: no process ownership, just session tracking. */
type ChannelEntry = {
  channelKey: string;
  sessionID: string;
  modelOverride?: string;
  currentMode?: string;
  state: SessionMessageState;
  createdAt: number;
};

type JsonRecord = Record<string, unknown>;

const MAIN_KEY = "__main__";
// DEFAULT_DELEGATION_TOKEN reserved for future main agent routing feature

const preview = (text: string, size = 120) => (text.length > size ? `${text.slice(0, size)}...` : text);

function newMessageState(): SessionMessageState {
  return {
    pendingPrompts: [],
    messageOrder: [],
    messageTexts: new Map(),
    lastActivityTime: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function parseModelSpec(spec?: string): { providerID: string; modelID: string } | undefined {
  if (!spec) return undefined;
  const trimmed = spec.trim();
  if (!trimmed) return undefined;
  const idx = trimmed.indexOf("/");
  if (idx <= 0 || idx >= trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, idx), modelID: trimmed.slice(idx + 1) };
}

function authHeader(config: AppConfig) {
  const user = config.opencode?.auth?.username;
  const pass = config.opencode?.auth?.password;
  if (!pass) return undefined;
  const username = user || "opencode";
  return `Basic ${Buffer.from(`${username}:${pass}`).toString("base64")}`;
}

async function requestJson<T>(
  config: AppConfig,
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json");
  const auth = authHeader(config);
  if (auth) headers.set("authorization", auth);
  if (config.opencode?.projectDirectory) {
    headers.set("x-opencode-directory", encodeURIComponent(config.opencode.projectDirectory));
  }
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// ProcessManager
// ---------------------------------------------------------------------------

export class ProcessManager {
  private sharedRuntime?: SharedRuntime;
  private readonly channels = new Map<string, ChannelEntry>();
  private monitorTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
  ) {}

  async initialize() {
    await this.sessions.load();
    console.log("[opencodebot] session store loaded, runtime monitor starting");
    this.monitorTimer = setInterval(async () => {
      await this.runMonitor();
    }, 15000);
  }

  async stopAll() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.sharedRuntime) {
      await this.disposeSharedRuntime(this.sharedRuntime);
    }
  }

  // -------------------------------------------------------------------------
  // Public API (signature-compatible with old ProcessManager)
  // -------------------------------------------------------------------------

  async resetSession(channelKey: string): Promise<string> {
    const runtime = await this.ensureSharedRuntime();
    const entry = await this.ensureChannelEntry(channelKey, runtime);
    console.log(`[opencodebot] [${channelKey}] creating new session`);
    const created = await requestJson<{ id: string }>(this.config, runtime.baseUrl, "/session", {
      method: "POST",
      body: JSON.stringify({ parentID: runtime.mainSessionID }),
    });
    entry.sessionID = created.id;
    entry.state = newMessageState();
    runtime.sessionIndex.set(created.id, channelKey);
    await this.sessions.set(channelKey, created.id);
    console.log(`[opencodebot] [${channelKey}] new session created: ${created.id}`);
    return created.id;
  }

  async listSessions(channelKey: string): Promise<Array<{ id: string; title: string }>> {
    const runtime = await this.ensureSharedRuntime();
    return await requestJson<Array<{ id: string; title: string }>>(this.config, runtime.baseUrl, "/session", {
      method: "GET",
    });
  }

  async setModel(channelKey: string, model: string): Promise<void> {
    const runtime = await this.ensureSharedRuntime();
    const entry = await this.ensureChannelEntry(channelKey, runtime);
    const parsed = await this.resolveModelSpec(entry, runtime, model);
    entry.modelOverride = `${parsed.providerID}/${parsed.modelID}`;
    await this.sessions.setModel(channelKey, entry.modelOverride);
    console.log(`[opencodebot] [${channelKey}] model override set to ${entry.modelOverride}`);
  }

  async getModel(channelKey: string): Promise<{ override?: string; current?: string }> {
    const runtime = await this.ensureSharedRuntime();
    const entry = await this.ensureChannelEntry(channelKey, runtime);
    let current: string | undefined;
    try {
      const messages = await requestJson<Array<{ info?: JsonRecord }>>(
        this.config,
        runtime.baseUrl,
        `/session/${entry.sessionID}/message?limit=20`,
        { method: "GET" },
      );
      for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i]?.info;
        if (info?.role === "assistant" && typeof info.providerID === "string" && typeof info.modelID === "string") {
          current = `${info.providerID}/${info.modelID}`;
          break;
        }
      }
    } catch {
      // ignore
    }
    return { override: entry.modelOverride, current };
  }

  async listModels(channelKey: string): Promise<string[]> {
    const runtime = await this.ensureSharedRuntime();
    console.log(`[opencodebot] [${channelKey}] -> opencode list models`);
    const response = await requestJson<{
      providers?: Array<{ id?: string; models?: Record<string, { id?: string; name?: string }> }>;
    }>(this.config, runtime.baseUrl, "/config/providers", { method: "GET" });
    const out: string[] = [];
    for (const provider of response.providers || []) {
      const providerID = provider.id;
      if (!providerID) continue;
      for (const [key, model] of Object.entries(provider.models || {})) {
        const modelID = model?.id || model?.name || key;
        if (!modelID) continue;
        out.push(`${providerID}/${modelID}`);
      }
    }
    const unique = Array.from(new Set(out)).sort();
    console.log(`[opencodebot] [${channelKey}] <- opencode list models count=${unique.length}`);
    return unique;
  }

  async runSlashCommand(channelKey: string, command: string, args: string[] = []): Promise<string> {
    const runtime = await this.ensureSharedRuntime();
    const entry = await this.ensureChannelEntry(channelKey, runtime);
    console.log(`[opencodebot] [${channelKey}] -> opencode slash command: /${command} ${args.join(" ")}`);
    const response = await requestJson<{ parts: Array<JsonRecord> }>(
      this.config,
      runtime.baseUrl,
      `/session/${entry.sessionID}/command`,
      {
        method: "POST",
        body: JSON.stringify({ command, arguments: args }),
      },
    );
    const text = this.extractText(response.parts) || "Done.";
    console.log(`[opencodebot] [${channelKey}] <- opencode slash response: ${preview(text)}`);
    return text;
  }

  async prompt(channelKey: string, text: string, systemPrompt?: string): Promise<string> {
    return this.promptInternal(channelKey, text, systemPrompt);
  }

  async promptPlan(channelKey: string, text: string): Promise<string> {
    return this.promptInternal(channelKey, text, undefined, "plan");
  }

  // -------------------------------------------------------------------------
  // Routing: messages go directly to the channel's child session.
  // The main session exists as a structural parent but does not intercept
  // messages. Main agent routing logic is reserved for future use.
  // -------------------------------------------------------------------------

  private async promptInternal(
    channelKey: string,
    text: string,
    systemPrompt?: string,
    agentOverride?: string,
  ): Promise<string> {
    const runtime = await this.ensureSharedRuntime();
    const entry = await this.ensureChannelEntry(channelKey, runtime);

    entry.state.lastActivityTime = Date.now();
    return await this.sendToSession(
      runtime,
      entry.sessionID,
      entry.state,
      channelKey,
      text,
      systemPrompt,
      entry.modelOverride,
      agentOverride,
    );
  }

  private async sendToSession(
    runtime: SharedRuntime,
    sessionID: string,
    state: SessionMessageState,
    logKey: string,
    text: string,
    systemPrompt?: string,
    modelOverride?: string,
    agentOverride?: string,
  ): Promise<string> {
    state.lastActivityTime = Date.now();
    console.log(
      `[opencodebot] [${logKey}] -> opencode session=${sessionID} text="${preview(text)}"` +
        (systemPrompt ? " with systemPrompt" : "") +
        (modelOverride ? ` model=${modelOverride}` : "") +
        (agentOverride ? ` agent=${agentOverride}` : ""),
    );

    const baselineMessageID = await this.getLatestAssistantMessageID(runtime, sessionID);
    const result = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for OpenCode response"));
      }, 180000);
      state.pendingPrompts.push({ baselineMessageID, resolve, reject, timer });
    });

    const body: JsonRecord = { parts: [{ type: "text", text }] };
    if (agentOverride) body.agent = agentOverride;
    const parsedModel = parseModelSpec(modelOverride);
    if (parsedModel) body.model = parsedModel;
    if (systemPrompt) body.system = systemPrompt;

    try {
      await requestJson(this.config, runtime.baseUrl, `/session/${sessionID}/prompt_async`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const response = await result;
      console.log(`[opencodebot] [${logKey}] <- opencode response: "${preview(response)}"`);
      return response;
    } catch (error) {
      const pending = state.pendingPrompts.pop();
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Runtime lifecycle
  // -------------------------------------------------------------------------

  private async ensureSharedRuntime(): Promise<SharedRuntime> {
    if (this.sharedRuntime && (await this.isHealthy(this.sharedRuntime.baseUrl))) {
      return this.sharedRuntime;
    }
    if (this.sharedRuntime) {
      await this.disposeSharedRuntime(this.sharedRuntime);
    }
    return await this.createSharedRuntime();
  }

  private async createSharedRuntime(): Promise<SharedRuntime> {
    console.log("[opencodebot] starting shared opencode server process");
    const server = await createManagedOpencodeServer({
      hostname: this.config.opencode?.hostname || "127.0.0.1",
      port: 0,
      timeout: 10000,
    });

    const sessionIndex = new Map<string, string>();
    const runtime: SharedRuntime = {
      baseUrl: server.url,
      pid: server.pid,
      close: server.close,
      mainSessionID: "",
      abort: new AbortController(),
      streamTask: Promise.resolve(),
      sessionIndex,
      mainState: newMessageState(),
      createdAt: Date.now(),
    };

    // Restore or create main session
    const savedMainID = this.sessions.getMainSessionID();
    if (savedMainID && (await this.sessionExists(runtime.baseUrl, savedMainID))) {
      runtime.mainSessionID = savedMainID;
      console.log(`[opencodebot] shared process pid=${runtime.pid} restored main session: ${savedMainID} @ ${runtime.baseUrl}`);
    } else {
      const created = await requestJson<{ id: string }>(this.config, runtime.baseUrl, "/session", {
        method: "POST",
        body: JSON.stringify({}),
      });
      runtime.mainSessionID = created.id;
      await this.sessions.setMainSessionID(created.id);
      console.log(`[opencodebot] shared process pid=${runtime.pid} created main session: ${created.id} @ ${runtime.baseUrl}`);
    }
    sessionIndex.set(runtime.mainSessionID, MAIN_KEY);

    // Restore channel sessions into the index
    for (const [channelKey, entry] of this.channels) {
      if (entry.sessionID) {
        sessionIndex.set(entry.sessionID, channelKey);
      }
    }

    this.sharedRuntime = runtime;
    runtime.streamTask = this.startEventStream(runtime);
    return runtime;
  }

  private async ensureChannelEntry(channelKey: string, runtime: SharedRuntime): Promise<ChannelEntry> {
    const existing = this.channels.get(channelKey);
    if (existing) {
      // Verify session still exists on server
      if (await this.sessionExists(runtime.baseUrl, existing.sessionID)) {
        return existing;
      }
      runtime.sessionIndex.delete(existing.sessionID);
    }

    // Create (or restore) child session
    const savedRecord = this.sessions.get(channelKey);
    let sessionID: string;

    if (savedRecord?.sessionID && (await this.sessionExists(runtime.baseUrl, savedRecord.sessionID))) {
      sessionID = savedRecord.sessionID;
      console.log(`[opencodebot] [${channelKey}] restored child session: ${sessionID}`);
    } else {
      const created = await requestJson<{ id: string }>(this.config, runtime.baseUrl, "/session", {
        method: "POST",
        body: JSON.stringify({ parentID: runtime.mainSessionID }),
      });
      sessionID = created.id;
      await this.sessions.set(channelKey, sessionID);
      console.log(`[opencodebot] [${channelKey}] created child session: ${sessionID} (parent: ${runtime.mainSessionID})`);
    }

    const entry: ChannelEntry = {
      channelKey,
      sessionID,
      modelOverride: savedRecord?.model,
      currentMode: "build",
      state: newMessageState(),
      createdAt: Date.now(),
    };
    this.channels.set(channelKey, entry);
    runtime.sessionIndex.set(sessionID, channelKey);
    return entry;
  }

  private async disposeSharedRuntime(runtime: SharedRuntime) {
    const runDurationSeconds = Math.round((Date.now() - runtime.createdAt) / 1000);
    console.log(
      `[opencodebot] closing shared process pid=${runtime.pid} (total runtime: ${runDurationSeconds}s)`,
    );
    runtime.abort.abort();
    // Reject all pending prompts across all sessions
    for (const pending of runtime.mainState.pendingPrompts) {
      clearTimeout(pending.timer);
      pending.reject(new Error("OpenCode runtime stopped"));
    }
    for (const entry of this.channels.values()) {
      for (const pending of entry.state.pendingPrompts) {
        clearTimeout(pending.timer);
        pending.reject(new Error("OpenCode runtime stopped"));
      }
      entry.state.pendingPrompts = [];
    }
    runtime.mainState.pendingPrompts = [];
    // Clear channel in-memory state (session IDs are persisted; will be restored on next use)
    this.channels.clear();
    const closeResult = await runtime.close();
    this.sharedRuntime = undefined;
    console.log(
      `[opencodebot] shared process closed pid=${runtime.pid} exited=${closeResult.exited} forced=${closeResult.forced}`,
    );
  }

  // -------------------------------------------------------------------------
  // Idle monitor
  // -------------------------------------------------------------------------

  private async runMonitor() {
    if (!this.sharedRuntime) return;
    const runtime = this.sharedRuntime;
    const now = Date.now();
    const idleTimeoutMs = this.config.opencode?.runtimeIdleTimeoutMs ?? 10 * 60 * 1000;

    // Check for any pending prompts across all sessions
    const hasActive =
      runtime.mainState.pendingPrompts.length > 0 ||
      Array.from(this.channels.values()).some((e) => e.state.pendingPrompts.length > 0);
    if (hasActive) return;

    // Compute last activity across main state and all channel states
    let lastActivity = runtime.mainState.lastActivityTime;
    for (const entry of this.channels.values()) {
      if (entry.state.lastActivityTime > lastActivity) {
        lastActivity = entry.state.lastActivityTime;
      }
    }

    if (now - lastActivity > idleTimeoutMs) {
      console.log(
        `[opencodebot] shared process idle for ${Math.round((now - lastActivity) / 1000)}s (limit: ${Math.round(idleTimeoutMs / 1000)}s), disposing`,
      );
      await this.disposeSharedRuntime(runtime);
      return;
    }

    // Health check
    try {
      if (!(await this.isHealthy(runtime.baseUrl))) {
        console.warn("[opencodebot] shared process unhealthy, rebuilding");
        await this.disposeSharedRuntime(runtime);
        await this.createSharedRuntime();
      }
    } catch (error) {
      console.error("[opencodebot] runtime monitor error", error);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async isHealthy(baseUrl: string): Promise<boolean> {
    try {
      await requestJson(this.config, baseUrl, "/global/health", { method: "GET" });
      return true;
    } catch {
      return false;
    }
  }

  private async sessionExists(baseUrl: string, sessionID: string): Promise<boolean> {
    try {
      await requestJson(this.config, baseUrl, `/session/${sessionID}`, { method: "GET" });
      return true;
    } catch {
      return false;
    }
  }

  private async getLatestAssistantMessageID(runtime: SharedRuntime, sessionID: string): Promise<string | undefined> {
    try {
      const messages = await requestJson<Array<{ info?: JsonRecord }>>(
        this.config,
        runtime.baseUrl,
        `/session/${sessionID}/message?limit=20`,
        { method: "GET" },
      );
      for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i]?.info;
        if (info?.role === "assistant" && typeof info.id === "string") {
          return info.id;
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  private async getLatestAssistantProvider(runtime: SharedRuntime, sessionID: string): Promise<string | undefined> {
    try {
      const messages = await requestJson<Array<{ info?: JsonRecord }>>(
        this.config,
        runtime.baseUrl,
        `/session/${sessionID}/message?limit=20`,
        { method: "GET" },
      );
      for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i]?.info;
        if (info?.role === "assistant" && typeof info.providerID === "string") {
          return info.providerID;
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  private async resolveModelSpec(
    entry: ChannelEntry,
    runtime: SharedRuntime,
    input: string,
  ): Promise<{ providerID: string; modelID: string }> {
    const direct = parseModelSpec(input);
    if (direct) return direct;
    const trimmed = input.trim();
    if (!trimmed) throw new Error("Invalid model format. Use provider/model or modelID");
    const fromOverride = parseModelSpec(entry.modelOverride)?.providerID;
    const fromSession = await this.getLatestAssistantProvider(runtime, entry.sessionID);
    const providerID = fromOverride || fromSession || "volcengine";
    return { providerID, modelID: trimmed };
  }

  // -------------------------------------------------------------------------
  // SSE streaming (single stream for all sessions)
  // -------------------------------------------------------------------------

  private async startEventStream(runtime: SharedRuntime): Promise<void> {
    while (!runtime.abort.signal.aborted) {
      try {
        const headers = new Headers();
        const auth = authHeader(this.config);
        if (auth) headers.set("authorization", auth);
        if (this.config.opencode?.projectDirectory) {
          headers.set("x-opencode-directory", encodeURIComponent(this.config.opencode.projectDirectory));
        }
        const res = await fetch(`${runtime.baseUrl}/event`, { headers, signal: runtime.abort.signal });
        if (!res.ok || !res.body) throw new Error(`SSE connect failed ${res.status}`);
        console.log("[opencodebot] SSE connected (shared stream)");
        await this.consumeSse(runtime, res.body);
      } catch (error) {
        if (runtime.abort.signal.aborted) break;
        console.error("[opencodebot] SSE disconnected", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async consumeSse(runtime: SharedRuntime, body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const event of events) {
          for (const line of event.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const json = trimmed.slice(5).trim();
            if (!json) continue;
            this.handleEvent(runtime, json);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleEvent(runtime: SharedRuntime, raw: string) {
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const payload = data?.payload ?? data;
    if (!payload?.type) return;

    if (payload.type === "message.part.updated") {
      const part = payload.properties?.part;
      if (!part || part.type !== "text") return;
      const state = this.stateForSession(runtime, part.sessionID);
      if (!state) return;
      const nextText = String(part.text ?? "");
      const previousText = state.messageTexts.get(part.messageID);
      if (nextText !== previousText) state.lastActivityTime = Date.now();
      if (!state.messageTexts.has(part.messageID)) state.messageOrder.push(part.messageID);
      state.latestMessageID = part.messageID;
      state.messageTexts.set(part.messageID, nextText);
      return;
    }

    if (payload.type === "message.updated") {
      const info = payload.properties?.info;
      if (info?.role === "assistant" && typeof info?.mode === "string") {
        const channelKey = runtime.sessionIndex.get(info.sessionID as string);
        if (channelKey && channelKey !== MAIN_KEY) {
          const entry = this.channels.get(channelKey);
          if (entry && entry.currentMode !== info.mode) {
            entry.currentMode = info.mode;
            console.log(`[opencodebot] [${channelKey}] mode switched to ${entry.currentMode}`);
          }
        }
      }
      return;
    }

    if (payload.type === "permission.asked") {
      const req = payload.properties;
      const permissionID = req?.id;
      const sessionID = req?.sessionID;
      const permission = req?.permission;
      const patterns = Array.isArray(req?.patterns) ? req.patterns.join(", ") : "";
      const channelKey = runtime.sessionIndex.get(sessionID as string) ?? "unknown";
      if (!permissionID) return;
      console.warn(
        `[opencodebot] [${channelKey}] permission requested id=${permissionID} permission=${permission} patterns=${patterns}`,
      );
      if (this.config.opencode?.autoApprovePermissions !== false) {
        void this.replyPermission(runtime, sessionID as string, permissionID, "once");
      }
      return;
    }

    if (payload.type === "session.status") {
      const status = payload.properties?.status;
      const statusType = typeof status === "string" ? status : status?.type;
      const sessionID = payload.properties?.sessionID as string | undefined;
      if (!sessionID) return;
      const channelKey = runtime.sessionIndex.get(sessionID) ?? "unknown";
      if (statusType && statusType !== "idle") {
        console.log(`[opencodebot] [${channelKey}] session status=${statusType}`);
      }
      if (statusType !== "idle") return;

      const state = this.stateForSession(runtime, sessionID);
      if (!state) return;
      const pending = state.pendingPrompts.shift();
      if (!pending) return;
      clearTimeout(pending.timer);
      const messageID = this.pickCompletedMessage(state, pending.baselineMessageID);
      const text = (messageID && state.messageTexts.get(messageID)) || "(no text response)";
      state.lastActivityTime = Date.now();
      console.log(`[opencodebot] [${channelKey}] session idle, completing pending prompt messageID=${messageID ?? "n/a"}`);
      pending.resolve(text.trim());
    }
  }

  private stateForSession(runtime: SharedRuntime, sessionID: string): SessionMessageState | undefined {
    if (sessionID === runtime.mainSessionID) return runtime.mainState;
    const channelKey = runtime.sessionIndex.get(sessionID);
    if (!channelKey || channelKey === MAIN_KEY) return undefined;
    return this.channels.get(channelKey)?.state;
  }

  private async replyPermission(
    runtime: SharedRuntime,
    sessionID: string,
    permissionID: string,
    response: "once" | "always" | "reject",
  ) {
    try {
      await requestJson<boolean>(
        this.config,
        runtime.baseUrl,
        `/session/${sessionID}/permissions/${permissionID}`,
        {
          method: "POST",
          body: JSON.stringify({ response, remember: response === "always" }),
        },
      );
      console.warn(`[opencodebot] auto-approved permission id=${permissionID} response=${response}`);
    } catch (error) {
      console.error(`[opencodebot] failed to respond permission id=${permissionID}`, error);
    }
  }

  private pickCompletedMessage(state: SessionMessageState, baselineMessageID?: string): string | undefined {
    for (let i = state.messageOrder.length - 1; i >= 0; i--) {
      const id = state.messageOrder[i];
      if (!baselineMessageID || id !== baselineMessageID) return id;
    }
    return state.latestMessageID;
  }

  private extractText(parts: Array<JsonRecord>): string {
    return parts
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("")
      .trim();
  }
}
