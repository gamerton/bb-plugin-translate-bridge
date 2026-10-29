import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { opencodeComplete } from "../lib/opencode-completion.ts";

test("OpenCode gets a private tool-free agent, correct PWD, and stdin without changing auth paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "translate-opencode-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(directory, "fake-opencode.cjs");
  await writeFile(cli, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv[2]==='session'){process.exit(0);}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);
process.stdin.on('end',()=>{
 const result={args:process.argv.slice(2),input,config:JSON.parse(fs.readFileSync('opencode.json','utf8')),cwd:process.cwd(),pwd:process.env.PWD,db:process.env.OPENCODE_DB,data:process.env.XDG_DATA_HOME,configDir:process.env.XDG_CONFIG_HOME,disableProject:process.env.OPENCODE_DISABLE_PROJECT_CONFIG};
 console.log(JSON.stringify({type:'text',part:{type:'text',text:JSON.stringify(result)}}));
});
`, { mode: 0o755 });
  const result = JSON.parse(await opencodeComplete({
    cwd: directory, model: "provider/model", system: "Translate only.", user: 'Привет @file $(not-a-command)',
    reasoningLevel: "low", timeoutMs: 5000,
  }, undefined, {
    ...process.env, BB_OPENCODE_EXECUTABLE: cli,
    XDG_DATA_HOME: "/test/auth-data", XDG_CONFIG_HOME: "/test/provider-settings",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", PWD: "/wrong-coding-workspace", OPENCODE_DB: "/test/auth.db",
  }));
  const agent = result.config.agents["translate-bridge"];
  assert.equal(agent.system, "Translate only.");
  assert.deepEqual(agent.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
  assert.equal(result.input, 'Привет @file $(not-a-command)');
  assert.equal(result.pwd, result.cwd);
  assert.notEqual(result.cwd, directory);
  assert.equal(result.db, "/test/auth.db");
  assert.equal(result.data, "/test/auth-data");
  assert.equal(result.configDir, "/test/provider-settings");
  assert.equal(result.disableProject, undefined);
  assert.ok(result.args.includes("--standalone"));
  assert.match(result.args[result.args.indexOf("--session") + 1], /^ses_[a-f0-9]{32}$/);
  assert.equal(result.args[result.args.indexOf("--title") + 1], "Translate Bridge");
  assert.equal(result.args[result.args.indexOf("--model") + 1], "provider/model#low");
  await assert.rejects(access(result.cwd), { code: "ENOENT" });
});

test("OpenCode error events are failures even when the CLI exits zero, with no diagnostic leakage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "translate-opencode-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(directory, "fake-opencode.cjs");
  await writeFile(cli, `#!${process.execPath}
console.log(JSON.stringify({type:'error',error:{message:'credential-must-not-leak'}}));
`, { mode: 0o755 });
  await assert.rejects(opencodeComplete({
    cwd: directory, model: "provider/model", system: "Translate.", user: "Привет", reasoningLevel: "", timeoutMs: 5000,
  }, undefined, { ...process.env, BB_OPENCODE_EXECUTABLE: cli }), (error: Error) => {
    assert.match(error.message, /request failed/);
    assert.ok(!error.message.includes("credential-must-not-leak"));
    return true;
  });
});
