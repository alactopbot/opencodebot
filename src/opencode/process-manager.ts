import type { AppConfig } from "../config.js";
import { SessionStore } from "./session-store.js";
import { createManagedOpencodeServer, type ManagedServerCloseResult } from "./server-process.js";

type RuntimeEntry = {
  channelKey: string;
  baseUrl: string;
  close: () => Promise<ManagedServerCloseResult>;
  pid: number;
  sessionID: string;
  modelOverride?: string;
  currentMode?: string;
  abort: AbortController;
  streamTask?: Promise<void>;
  latestMessageID?: string;
  messageOrder: string[];
  messageTexts: Map<string, string>;
  pendingPrompts: Array<{
    baselineMessageID?: string;
    resolve: (value: string) => void;
    reject: (reason?: unknown) => void;
    timer: NodeJS.Timeout;
  }>;
  lastActivityTime: number;
  createdAt: number;
};

type JsonRecord = Record<string, unknown>;
const preview = (text: string, size = 120) => (text.length > size ? `${text.slice(0, size)}...` : text);

function parseModelSpec(spec?: string): { providerID: string; modelID: string } | undefined {
  if (!spec) return undefined;
  const trimmed = spec.trim();
  if (!trimmed) return undefined;
  const idx = trimmed.indexOf("/");
  if (idx <= 0 || idx >= trimmed.length - 1) return undefined;
  return {
    providerID: trimmed.slice(0, idx),
    modelID: trimmed.slice(idx + 1),
  };
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
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export class ProcessManager {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private monitorTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
  ) {}

  async initialize() {
    await this.sessions.load();
    console.log("[opencodebot] session store loaded, runtime monitor starting");
    this.monitorTimer = setInterval(async () => {
      const now = Date.now();
      const idleTimeoutMs = this.config.opencode?.runtimeIdleTimeoutMs ?? 10 * 60 * 1000; // 默认 10 分钟
      
      for (const [channelKey] of this.runtimes) {
        try {
          // 首先检查是否空闲超时
          const runtime = this.runtimes.get(channelKey);
          if (!runtime) continue;
          // 仍有进行中的 prompt，不应被判定为空闲
          if (runtime.pendingPrompts.length > 0) continue;
          if (now - runtime.lastActivityTime > idleTimeoutMs) {
            console.log(
              `[opencodebot] [${channelKey}] runtime idle for ${Math.round((now - runtime.lastActivityTime) / 1000)}s (limit: ${Math.round(idleTimeoutMs / 1000)}s), disposing`,
            );
            await this.disposeRuntime(runtime);
            continue;
          }
          
          // 然后检查健康状态
          await this.recoverIfUnhealthy(channelKey);
        } catch (error) {
          console.error(`[opencodebot] runtime monitor failed for ${channelKey}`, error);
        }
      }
    }, 15000);
  }

  async stopAll() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    console.log(`[opencodebot] stopping ${this.runtimes.size} opencode runtime(s)`);
    for (const runtime of this.runtimes.values()) {
      runtime.abort.abort();
      for (const pending of runtime.pendingPrompts) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Runtime stopped"));
      }
      const closeResult = await runtime.close();
      console.log(
        `[opencodebot] [${runtime.channelKey}] runtime process closed pid=${runtime.pid} exited=${closeResult.exited} forced=${closeResult.forced}`,
      );
    }
    this.runtimes.clear();
  }

  async resetSession(channelKey: string): Promise<string> {
    const runtime = await this.ensureRuntime(channelKey);
    console.log(`[opencodebot] [${channelKey}] creating new session`);
    const created = await requestJson<{ id: string }>(this.config, runtime.baseUrl, "/session", {
      method: "POST",
      body: JSON.stringify({}),
    });
    runtime.sessionID = created.id;
    await this.sessions.set(channelKey, created.id);
    console.log(`[opencodebot] [${channelKey}] new session created: ${created.id}`);
    return created.id;
  }

  async listSessions(channelKey: string): Promise<Array<{ id: string; title: string }>> {
    const runtime = await this.ensureRuntime(channelKey);
    return await requestJson<Array<{ id: string; title: string }>>(this.config, runtime.baseUrl, "/session", {
      method: "GET",
    });
  }

  async setModel(channelKey: string, model: string): Promise<void> {
    const runtime = await this.ensureRuntime(channelKey);
    const parsed = await this.resolveModelSpec(runtime, model);
    runtime.modelOverride = `${parsed.providerID}/${parsed.modelID}`;
    await this.sessions.setModel(channelKey, runtime.modelOverride);
    console.log(`[opencodebot] [${channelKey}] model override set to ${runtime.modelOverride}`);
  }

  async getModel(channelKey: string): Promise<{ override?: string; current?: string }> {
    const runtime = await this.ensureRuntime(channelKey);
    let current: string | undefined;
    try {
      const messages = await requestJson<Array<{ info?: JsonRecord }>>(
        this.config,
        runtime.baseUrl,
        `/session/${runtime.sessionID}/message?limit=20`,
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
    return { override: runtime.modelOverride, current };
  }

  async listModels(channelKey: string): Promise<string[]> {
    const runtime = await this.ensureRuntime(channelKey);
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
    const runtime = await this.ensureRuntime(channelKey);
    console.log(`[opencodebot] [${channelKey}] -> opencode slash command: /${command} ${args.join(" ")}`);
    const response = await requestJson<{ parts: Array<JsonRecord> }>(
      this.config,
      runtime.baseUrl,
      `/session/${runtime.sessionID}/command`,
      {
        method: "POST",
        body: JSON.stringify({
          command,
          arguments: args,
        }),
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

  private async promptInternal(
    channelKey: string,
    text: string,
    systemPrompt?: string,
    agentOverride?: string,
  ): Promise<string> {
    const runtime = await this.ensureRuntime(channelKey);
    runtime.lastActivityTime = Date.now();
    console.log(
      `[opencodebot] [${channelKey}] -> opencode prompt(session=${runtime.sessionID}) text="${preview(text)}"${
        systemPrompt ? " with systemPrompt" : ""
      }${runtime.modelOverride ? ` model=${runtime.modelOverride}` : ""}${agentOverride ? ` agent=${agentOverride}` : ""}`,
    );
    const baselineMessageID = await this.getLatestAssistantMessageID(runtime);
    const result = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for OpenCode response"));
      }, 180000);
      runtime.pendingPrompts.push({ baselineMessageID, resolve, reject, timer });
    });
    const body: JsonRecord = {
      parts: [{ type: "text", text }],
    };
    if (agentOverride) {
      body.agent = agentOverride;
    }
    const parsedModel = parseModelSpec(runtime.modelOverride);
    if (parsedModel) {
      body.model = parsedModel;
    }
    if (systemPrompt) {
      body.system = systemPrompt;
    }
    try {
      await requestJson(
        this.config,
        runtime.baseUrl,
        `/session/${runtime.sessionID}/prompt_async`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      const response = await result;
      console.log(`[opencodebot] [${channelKey}] <- opencode response: ${preview(response)}`);
      return response;
    } catch (error) {
      const pending = runtime.pendingPrompts.pop();
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      throw error;
    }
  }

  private async ensureRuntime(channelKey: string): Promise<RuntimeEntry> {
    const existing = this.runtimes.get(channelKey);
    if (existing && (await this.isHealthy(existing.baseUrl))) {
      return existing;
    }
    if (existing) {
      await this.disposeRuntime(existing);
    }

    return await this.createRuntime(channelKey);
  }

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

  private async createRuntime(channelKey: string, preferredSessionID?: string): Promise<RuntimeEntry> {
    console.log(`[opencodebot] [${channelKey}] starting opencode server process`);
    const server = await createManagedOpencodeServer({
      hostname: this.config.opencode?.hostname || "127.0.0.1",
      port: 0,
      timeout: 10000,
    });
    const now = Date.now();
    const runtime: RuntimeEntry = {
      channelKey,
      baseUrl: server.url,
      close: server.close,
      pid: server.pid,
      sessionID: "",
      modelOverride: this.sessions.get(channelKey)?.model,
      currentMode: "build",
      abort: new AbortController(),
      messageOrder: [],
      messageTexts: new Map(),
      pendingPrompts: [],
      lastActivityTime: now,
      createdAt: now,
    };

    const saved = preferredSessionID || this.sessions.get(channelKey)?.sessionID;
    if (saved && (await this.sessionExists(runtime.baseUrl, saved))) {
      runtime.sessionID = saved;
      console.log(
        `[opencodebot] [${channelKey}] runtime process opened pid=${runtime.pid} (restored session: ${saved} @ ${runtime.baseUrl})`,
      );
    } else {
      const created = await requestJson<{ id: string }>(this.config, runtime.baseUrl, "/session", {
        method: "POST",
        body: JSON.stringify({}),
      });
      runtime.sessionID = created.id;
      await this.sessions.set(channelKey, created.id);
      console.log(
        `[opencodebot] [${channelKey}] runtime process opened pid=${runtime.pid} (created session: ${created.id} @ ${runtime.baseUrl})`,
      );
    }

    this.runtimes.set(channelKey, runtime);
    runtime.streamTask = this.startEventStream(runtime);
    return runtime;
  }

  private async recoverIfUnhealthy(channelKey: string) {
    const runtime = this.runtimes.get(channelKey);
    if (!runtime) return;
    if (await this.isHealthy(runtime.baseUrl)) return;
    console.warn(`[opencodebot] [${channelKey}] runtime unhealthy, rebuilding process`);
    const previousSession = runtime.sessionID;
    await this.disposeRuntime(runtime);
    await this.createRuntime(channelKey, previousSession);
    console.log(`[opencodebot] [${channelKey}] runtime recovered`);
  }

  private async disposeRuntime(runtime: RuntimeEntry) {
    const idleSeconds = Math.round((Date.now() - runtime.lastActivityTime) / 1000);
    const runDurationSeconds = Math.round((Date.now() - runtime.createdAt) / 1000);
    console.log(
      `[opencodebot] [${runtime.channelKey}] closing runtime process pid=${runtime.pid} (idle: ${idleSeconds}s, total runtime: ${runDurationSeconds}s, session: ${runtime.sessionID})`,
    );
    runtime.abort.abort();
    for (const pending of runtime.pendingPrompts) {
      clearTimeout(pending.timer);
      pending.reject(new Error("OpenCode runtime stopped"));
    }
    runtime.pendingPrompts = [];
    const closeResult = await runtime.close();
    this.runtimes.delete(runtime.channelKey);
    console.log(
      `[opencodebot] [${runtime.channelKey}] runtime process closed pid=${runtime.pid} exited=${closeResult.exited} forced=${closeResult.forced}`,
    );
  }

  private async getLatestAssistantMessageID(runtime: RuntimeEntry): Promise<string | undefined> {
    try {
      const messages = await requestJson<Array<{ info?: JsonRecord }>>(
        this.config,
        runtime.baseUrl,
        `/session/${runtime.sessionID}/message?limit=20`,
        { method: "GET" },
      );
      for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i]?.info;
        if (info?.role === "assistant" && typeof info.id === "string") {
          return info.id;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async getLatestAssistantProvider(runtime: RuntimeEntry): Promise<string | undefined> {
    try {
      const messages = await requestJson<Array<{ info?: JsonRecord }>>(
        this.config,
        runtime.baseUrl,
        `/session/${runtime.sessionID}/message?limit=20`,
        { method: "GET" },
      );
      for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i]?.info;
        if (info?.role === "assistant" && typeof info.providerID === "string") {
          return info.providerID;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveModelSpec(runtime: RuntimeEntry, input: string): Promise<{ providerID: string; modelID: string }> {
    const direct = parseModelSpec(input);
    if (direct) return direct;
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("Invalid model format. Use provider/model or modelID");
    }
    const fromOverride = parseModelSpec(runtime.modelOverride)?.providerID;
    const fromSession = await this.getLatestAssistantProvider(runtime);
    const providerID = fromOverride || fromSession || "volcengine";
    return { providerID, modelID: trimmed };
  }

  private async startEventStream(runtime: RuntimeEntry): Promise<void> {
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
        console.log(`[opencodebot] [${runtime.channelKey}] SSE connected`);
        await this.consumeSse(runtime, res.body);
      } catch (error) {
        if (runtime.abort.signal.aborted) break;
        console.error(`[opencodebot] SSE disconnected for ${runtime.channelKey}`, error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async consumeSse(runtime: RuntimeEntry, body: ReadableStream<Uint8Array>) {
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

  private handleEvent(runtime: RuntimeEntry, raw: string) {
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
      if (!part || part.sessionID !== runtime.sessionID || part.type !== "text") return;
      const nextText = String(part.text ?? "");
      const previousText = runtime.messageTexts.get(part.messageID);
      // 仅在文本内容真正变化时刷新活动时间，避免重复事件导致空闲计时被重置
      if (nextText !== previousText) {
        runtime.lastActivityTime = Date.now();
      }
      if (!runtime.messageTexts.has(part.messageID)) {
        runtime.messageOrder.push(part.messageID);
      }
      runtime.latestMessageID = part.messageID;
      runtime.messageTexts.set(part.messageID, nextText);
      return;
    }
    if (payload.type === "message.updated") {
      const info = payload.properties?.info;
      if (info?.sessionID === runtime.sessionID && info?.role === "assistant" && typeof info?.mode === "string") {
        if (runtime.currentMode !== info.mode) {
          runtime.currentMode = info.mode;
          console.log(`[opencodebot] [${runtime.channelKey}] mode switched to ${runtime.currentMode}`);
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
      if (!permissionID || sessionID !== runtime.sessionID) return;
      console.warn(
        `[opencodebot] [${runtime.channelKey}] permission requested id=${permissionID} permission=${permission} patterns=${patterns}`,
      );
      if (this.config.opencode?.autoApprovePermissions !== false) {
        void this.replyPermission(runtime, permissionID, "once");
      } else {
        console.warn(
          `[opencodebot] [${runtime.channelKey}] autoApprovePermissions=false, waiting for manual permission handling`,
        );
      }
      return;
    }
    if (payload.type === "session.status") {
      const status = payload.properties?.status;
      const statusType = typeof status === "string" ? status : status?.type;
      const sessionID = payload.properties?.sessionID;
      if (sessionID === runtime.sessionID && statusType && statusType !== "idle") {
        console.log(`[opencodebot] [${runtime.channelKey}] session status=${statusType}`);
      }
      if (sessionID !== runtime.sessionID || statusType !== "idle") return;
      const pending = runtime.pendingPrompts.shift();
      if (!pending) return;
      clearTimeout(pending.timer);
      const messageID = this.pickCompletedMessage(runtime, pending.baselineMessageID);
      const text = (messageID && runtime.messageTexts.get(messageID)) || "(no text response)";
      runtime.lastActivityTime = Date.now();
      console.log(
        `[opencodebot] [${runtime.channelKey}] session idle, completing pending prompt messageID=${messageID ?? "n/a"}`,
      );
      pending.resolve(text.trim());
    }
  }

  private async replyPermission(
    runtime: RuntimeEntry,
    permissionID: string,
    response: "once" | "always" | "reject",
  ) {
    try {
      await requestJson<boolean>(
        this.config,
        runtime.baseUrl,
        `/session/${runtime.sessionID}/permissions/${permissionID}`,
        {
          method: "POST",
          body: JSON.stringify({ response, remember: response === "always" }),
        },
      );
      console.warn(
        `[opencodebot] [${runtime.channelKey}] auto-approved permission id=${permissionID} response=${response}`,
      );
    } catch (error) {
      console.error(
        `[opencodebot] [${runtime.channelKey}] failed to respond permission id=${permissionID}`,
        error,
      );
    }
  }

  private pickCompletedMessage(runtime: RuntimeEntry, baselineMessageID?: string): string | undefined {
    for (let i = runtime.messageOrder.length - 1; i >= 0; i--) {
      const id = runtime.messageOrder[i];
      if (!baselineMessageID || id !== baselineMessageID) return id;
    }
    return runtime.latestMessageID;
  }

  private extractText(parts: Array<JsonRecord>): string {
    const textParts = parts
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("");
    return textParts.trim();
  }
}
