import { spawn } from "node:child_process";

export type ManagedServerCloseResult = {
  exited: boolean;
  forced: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type ManagedOpencodeServer = {
  url: string;
  pid: number;
  close: () => Promise<ManagedServerCloseResult>;
};

type StartOptions = {
  hostname: string;
  port: number;
  timeout: number;
  signal?: AbortSignal;
};

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    return signalProcess(pid, signal);
  }
}

export async function createManagedOpencodeServer(options: StartOptions): Promise<ManagedOpencodeServer> {
  const args = [`serve`, `--hostname=${options.hostname}`, `--port=${options.port}`];
  const proc = spawn(`opencode`, args, {
    signal: options.signal,
    detached: true,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({}),
    },
  });

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  proc.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });

  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (exited) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        proc.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        proc.off("exit", onExit);
        resolve(true);
      };
      proc.on("exit", onExit);
    });
  };

  let closePromise: Promise<ManagedServerCloseResult> | undefined;
  const close = async (): Promise<ManagedServerCloseResult> => {
    if (closePromise) return await closePromise;
    closePromise = (async () => {
      if (!exited) {
        signalProcessGroup(proc.pid!, "SIGTERM");
      }
      const exitedAfterTerm = await waitForExit(2000);
      if (!exitedAfterTerm) {
        signalProcessGroup(proc.pid!, "SIGKILL");
      }
      const exitedAfterKill = exitedAfterTerm || (await waitForExit(2000));
      return {
        exited: exitedAfterKill,
        forced: !exitedAfterTerm,
        code: exitCode,
        signal: exitSignal,
      };
    })();
    return await closePromise;
  };

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for server to start after ${options.timeout}ms`));
    }, options.timeout);

    let output = "";
    const onStdout = (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          clearTimeout(timer);
          cleanupListeners();
          reject(new Error(`Failed to parse server url from output: ${line}`));
          return;
        }
        clearTimeout(timer);
        cleanupListeners();
        resolve(match[1]);
        return;
      }
    };
    const onStderr = (chunk: Buffer) => {
      output += chunk.toString();
    };
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      cleanupListeners();
      let msg = `Server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      cleanupListeners();
      reject(error);
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanupListeners();
      reject(new Error("Aborted"));
    };
    const cleanupListeners = () => {
      proc.stdout?.off("data", onStdout);
      proc.stderr?.off("data", onStderr);
      proc.off("exit", onExit);
      proc.off("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
    };

    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("exit", onExit);
    proc.on("error", onError);
    options.signal?.addEventListener("abort", onAbort);
  }).catch(async (error) => {
    await close().catch(() => undefined);
    throw error;
  });

  return {
    url,
    pid: proc.pid ?? -1,
    close,
  };
}
