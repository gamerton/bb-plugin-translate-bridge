import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexComplete } from "../lib/codex-completion.ts";

test("Codex uses an isolated ephemeral tool-free session and cleans temporary translation files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "translate-codex-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(directory, "fake-codex.cjs");
  await writeFile(cli, `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
const config=Object.fromEntries(args.flatMap((arg,index)=> arg==='--config' ? [args[index+1].split(/=(.*)/s).slice(0,2)] : []));
const instructionPath=JSON.parse(config.model_instructions_file);
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);
process.stdin.on('end',()=>{
 const output=args[args.indexOf('--output-last-message')+1];
 fs.writeFileSync(output,JSON.stringify({args,config,input,instructions:fs.readFileSync(instructionPath,'utf8'),cwd:process.cwd()}));
});
`, { mode: 0o755 });
  const result = JSON.parse(await codexComplete({
    cwd: directory, model: "test-model", system: "Translate only.", user: 'Привет `code` $(not-a-command)',
    reasoningLevel: "none", timeoutMs: 5000,
  }, undefined, { ...process.env, BB_CODEX_EXECUTABLE: cli }));
  assert.equal(result.instructions, "Translate only.");
  assert.equal(result.input, 'Привет `code` $(not-a-command)');
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check"]) assert.ok(result.args.includes(flag));
  assert.equal(JSON.parse(result.config.model_reasoning_effort), "none");
  for (const key of ["features.shell_tool", "features.view_image", "features.apply_patch_freeform", "features.multi_agent_v2", "features.code_mode", "features.js_repl", "features.apps", "features.plugins", "tools.update_plan.enabled"]) assert.equal(result.config[key], "false");
  assert.equal(result.config.project_doc_max_bytes, "0");
  assert.notEqual(result.cwd, directory);
  await assert.rejects(access(result.cwd), { code: "ENOENT" });
});
