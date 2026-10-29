import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runCli, type CliCompletionRequest } from "./cli-process.ts";

/** OpenCode V2: a private server and a dedicated agent, never the shared coding session. */
export async function opencodeComplete(
  request: CliCompletionRequest,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "translate-bridge-opencode-"));
  const sessionId = `ses_${randomBytes(16).toString("hex")}`;
  const executable = env.BB_OPENCODE_EXECUTABLE?.trim() || "opencode";
  // Credentials and sessions share OpenCode's DB. Keep the normal auth store,
  // then delete only the fresh translation session, never a coding session.
  const childEnv: NodeJS.ProcessEnv = { ...env, PWD: directory };
  delete childEnv.OPENCODE_DISABLE_PROJECT_CONFIG;
  try {
    const config = {
      agents: {
        "translate-bridge": {
          mode: "primary",
          system: request.system,
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        },
      },
    };
    await writeFile(join(directory, "opencode.json"), JSON.stringify(config), { mode: 0o600 });
    const model = request.reasoningLevel !== "" && !request.model.includes("#")
      ? `${request.model}#${request.reasoningLevel}` : request.model;
    const result = await runCli({
      executable,
      args: ["run", "--standalone", "--format", "json", "--title", "Translate Bridge", "--session", sessionId, "--model", model, "--agent", "translate-bridge"],
      input: request.user, cwd: directory, env: childEnv,
      timeoutMs: request.timeoutMs, label: "OpenCode",
    }, signal);
    const parts: string[] = [];
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      let event: { type?: string; part?: { type?: string; text?: unknown }; error?: { type?: unknown } };
      try { event = JSON.parse(line); }
      catch { throw new Error("OpenCode translator returned invalid JSON"); }
      if (event.type === "error") {
        const kind = event.error?.type;
        const suffix = typeof kind === "string" && /^[a-z][a-z0-9.-]{0,79}$/u.test(kind) ? ` (${kind})` : "";
        throw new Error(`OpenCode translator request failed${suffix}. Check CLI login, model and service limits on the selected machine.`);
      }
      if (event.type === "text" && event.part?.type === "text" && typeof event.part.text === "string") parts.push(event.part.text);
    }
    if (result.code !== 0) throw new Error(`OpenCode translator exited with code ${result.code}. Requires OpenCode 2.x; check CLI login, model and service limits on the selected machine.`);
    const text = parts.join("");
    if (text.trim() === "") throw new Error("OpenCode translator returned no translation");
    return text;
  } finally {
    try {
      // Cleanup must still run after cancellation; never print CLI diagnostics.
      await runCli({ executable, args: ["session", "delete", "--standalone", sessionId],
        input: "", cwd: directory, env: childEnv, timeoutMs: 2500, label: "OpenCode cleanup" });
    } catch { /* a crash/offline host may leave the translation session behind */ }
    await rm(directory, { recursive: true, force: true });
  }
}
