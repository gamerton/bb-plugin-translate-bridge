import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliCompletionRequest } from "./cli-process.ts";

/** No user/project configuration, but Codex still uses its normal login store. */
export async function codexComplete(
  request: CliCompletionRequest,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "translate-bridge-codex-"));
  try {
    const instructions = join(directory, "instructions.md");
    const output = join(directory, "translation.txt");
    await writeFile(instructions, request.system, { mode: 0o600 });
    const config: Record<string, string | number | boolean> = {
      model_instructions_file: instructions,
      project_doc_max_bytes: 0,
      developer_instructions: "",
      include_permissions_instructions: false,
      include_collaboration_mode_instructions: false,
      include_apps_instructions: false,
      "tools.update_plan.enabled": false,
      "tools.experimental_request_user_input.enabled": false,
      "agents.enabled": false,
      web_search: "disabled",
      "skills.include_instructions": false,
      "skills.bundled.enabled": false,
      "features.shell_tool": false,
      "features.view_image": false,
      "features.apply_patch_freeform": false,
      "features.multi_agent": false,
      "features.multi_agent_v2": false,
      "features.code_mode": false,
      "features.js_repl": false,
      "features.apps": false,
      "features.plugins": false,
      "features.memories": false,
      "features.goals": false,
      "features.hooks": false,
      "features.codex_hooks": false,
    };
    if (request.reasoningLevel !== "") config.model_reasoning_effort = request.reasoningLevel;
    const args = [
      "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
      "--skip-git-repo-check", "--sandbox", "read-only", "--json",
      "--model", request.model, "--cd", directory, "--output-last-message", output,
    ];
    for (const [key, value] of Object.entries(config)) args.push("--config", `${key}=${JSON.stringify(value)}`);
    const result = await runCli({
      executable: env.BB_CODEX_EXECUTABLE?.trim() || "codex", args,
      input: request.user, cwd: directory, env: { ...env },
      timeoutMs: request.timeoutMs, label: "Codex",
    }, signal);
    if (result.code !== 0) throw new Error(`Codex translator exited with code ${result.code}. Check CLI login, model and service limits on the selected machine.`);
    const size = await stat(output).catch(() => null);
    if (!size || size.size > 2 * 1024 * 1024) throw new Error("Codex translator returned no translation or exceeded 2 MiB");
    const text = await readFile(output, "utf8");
    if (text.trim() === "") throw new Error("Codex translator returned no translation");
    return text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
