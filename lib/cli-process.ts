import { spawn } from "node:child_process";

export interface CliCompletionRequest {
  model: string;
  system: string;
  user: string;
  cwd: string;
  reasoningLevel: string;
  timeoutMs: number;
}

interface CliProcessRequest {
  executable: string;
  args: string[];
  input: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  label: string;
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function runCli(request: CliProcessRequest, signal?: AbortSignal): Promise<{ stdout: string; code: number | null }> {
  if (signal?.aborted) return Promise.reject(new Error(`${request.label} translation cancelled`));
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd, env: request.env, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let output = "";
    let bytes = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (force: boolean) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        else child.kill(force ? "SIGKILL" : "SIGTERM");
      } catch { /* already exited */ }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill(false);
      killTimer = setTimeout(() => kill(true), 1000);
      killTimer.unref();
    };
    const cancel = () => stop(new Error(`${request.label} translation cancelled`));
    const timer = setTimeout(() => stop(new Error(`${request.label} translation timed out after ${request.timeoutMs / 1000}s`)), request.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancel);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) stop(new Error(`${request.label} translation output exceeded 2 MiB`));
      else output += chunk;
    });
    // Drain stderr, but never return it: CLI diagnostics may include credentials.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {}); // early CLI exit can close stdin
    child.on("error", (error) => {
      cleanup();
      reject(new Error(`Could not start ${request.label} translator (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Check the CLI on the selected machine.`));
    });
    child.on("close", (code) => {
      cleanup();
      if (failure) return reject(failure);
      resolve({ stdout: output, code });
    });
    child.stdin.end(request.input);
  });
}
