import { runCli, type CliCompletionRequest } from "./cli-process.ts";
export type ClaudeCompletionRequest = CliCompletionRequest;

export async function claudeComplete(
  request: CliCompletionRequest,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const args = [
    "--print", "--output-format", "json",
    "--model", request.model,
    "--tools", "",
    "--system-prompt", request.system,
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands", "--no-session-persistence", "--no-chrome",
  ];
  if (["low", "medium", "high", "xhigh", "max"].includes(request.reasoningLevel)) {
    args.push("--effort", request.reasoningLevel);
  }
  const childEnv = { ...env };
  delete childEnv.CLAUDECODE;
  const { stdout, code } = await runCli({
    executable: env.BB_CLAUDE_CODE_EXECUTABLE?.trim() || "claude", args,
    input: request.user, cwd: request.cwd, env: childEnv,
    timeoutMs: request.timeoutMs, label: "Claude",
  }, signal);
  let result: { is_error?: boolean; result?: unknown; api_error_status?: unknown };
  try { result = JSON.parse(stdout); }
  catch {
    throw new Error(code !== 0
      ? `Claude translator exited with code ${code}. Check CLI login, model and settings on the selected machine.`
      : "Claude translator returned invalid JSON");
  }
  if (code !== 0 || result.is_error) {
    const status = result.api_error_status;
    const suffix = typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? ` (HTTP ${status})` : "";
    throw new Error(`Claude translator request failed${suffix}. Check CLI login, model, service limits and settings on the selected machine.`);
  }
  if (typeof result.result !== "string" || result.result.trim() === "") {
    throw new Error("Claude translator returned no translation");
  }
  return result.result;
}
