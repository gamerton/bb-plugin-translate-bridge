import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { claudeComplete } from "../lib/claude-completion.ts";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "translate-claude-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const cli = join(cwd, "fake-claude.cjs");
  await writeFile(cli, `#!${process.execPath}
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE;
if (mode === 'wait') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'error') {
  console.error('secret-credential-must-not-leak'); process.exit(1);
} else if (mode === 'invalid') {
  console.log('not json');
} else if (mode === 'semantic-error') {
  console.log(JSON.stringify({is_error:true,result:'secret-credential-must-not-leak'}));
} else if (mode === 'rate-limit') {
  console.log(JSON.stringify({is_error:true,api_error_status:429,result:'secret-credential-must-not-leak'})); process.exitCode=1;
} else if (mode === 'overflow') {
  process.stdout.write('x'.repeat(3 * 1024 * 1024));
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', s => input += s);
  process.stdin.on('end', () => console.log(JSON.stringify({result:JSON.stringify({args,input,cwd:process.cwd(),nested:process.env.CLAUDECODE,auth:process.env.CLAUDE_CODE_OAUTH_TOKEN})})));
}
`, { mode: 0o755 });
  return {
    request: { cwd, model: "test-model", system: "Translate only", user: 'Привет `x` $(never-run)', reasoningLevel: "low", timeoutMs: 5000 },
    env: { ...process.env, BB_CLAUDE_CODE_EXECUTABLE: cli, CLAUDECODE: "nested", CLAUDE_CODE_OAUTH_TOKEN: "fake-login" },
  };
}

test("Claude translations disable tools/MCP/skills and replace the prompt while retaining CLI login", async (t) => {
  const { request, env } = await fixture(t);
  const result = JSON.parse(await claudeComplete(request, undefined, env));
  const value = (flag: string) => result.args[result.args.indexOf(flag) + 1];
  assert.equal(value("--tools"), "");
  assert.equal(value("--system-prompt"), request.system);
  assert.equal(value("--mcp-config"), '{"mcpServers":{}}');
  for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--no-chrome"]) assert.ok(result.args.includes(flag));
  assert.ok(!result.args.includes("--bare"));
  assert.equal(value("--model"), request.model);
  assert.equal(value("--effort"), "low");
  assert.equal(result.input, request.user);
  assert.equal(result.cwd, request.cwd);
  assert.equal(result.nested, undefined);
  assert.equal(result.auth, "fake-login");
});

test("CLI failures never expose diagnostic credentials", async (t) => {
  const { request, env } = await fixture(t);
  for (const mode of ["error", "semantic-error", "invalid", "overflow"]) {
    await assert.rejects(claudeComplete(request, undefined, { ...env, FAKE_CLAUDE_MODE: mode }), (error: Error) => {
      assert.ok(!error.message.includes("secret-credential"));
      return true;
    });
  }
  await assert.rejects(claudeComplete(request, undefined, { ...env, FAKE_CLAUDE_MODE: "rate-limit" }), /HTTP 429/);
});

test("timeout and cancellation stop even a CLI that ignores SIGTERM", async (t) => {
  const { request, env } = await fixture(t);
  const waitingEnv = { ...env, FAKE_CLAUDE_MODE: "wait" };
  await assert.rejects(claudeComplete({ ...request, timeoutMs: 150 }, undefined, waitingEnv), /timed out/);
  const controller = new AbortController();
  const running = claudeComplete(request, controller.signal, waitingEnv);
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(running, /cancelled/);
  await assert.rejects(claudeComplete(request, controller.signal, waitingEnv), /cancelled/);
});
