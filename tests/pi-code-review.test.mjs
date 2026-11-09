import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("../ai/pi/", import.meta.url));
const agents = ["code-review-rules", "code-review-bugs"];
const models = ["claude-bridge/claude-sonnet-5-5", "claude-bridge/claude-opus-5-5"];
let sdk;
let sdkUnavailable;
try {
  let host = process.env.PI_SDK_DIR;
  if (!host) {
    const agent = join(homedir(), ".pi/agent");
    const version = readFileSync(join(agent, "install/current-version"), "utf8").trim();
    host = join(agent, "install/releases", version, "node_modules/@earendil-works/pi-coding-agent");
  }
  sdk = await import(pathToFileURL(join(host, "dist/index.js")).href);
} catch (error) {
  sdkUnavailable = "Pi SDK unavailable: " + error.message;
}

test("code-review keeps its original models, read-only tools and publication opt-in", () => {
  agents.forEach((name, index) => {
    const body = readFileSync(join(source, "agents", name + ".md"), "utf8");
    assert(body.includes("name: " + name));
    assert(body.includes("model: " + models[index]));
    assert(body.includes("tools: read, grep, find, ls"));
    assert(body.includes("ponytail: off"));
  });
  const prompt = readFileSync(join(source, "prompts/code-review.md"), "utf8");
  assert(prompt.includes("$@"));
  assert(prompt.includes('agentScope: "user"'));
  assert(prompt.includes("Sem `--comment`, pare aqui. Não publique nada no GitHub."));
  assert(prompt.includes("Não publique uma revisão parcial."));
  assert(prompt.includes("merge_base_commit.sha"));
  assert(prompt.includes("<!-- pi-code-review:head=SHA -->"));
});

test("symlinked review resources load and delegate without model or network calls", { skip: sdkUnavailable }, async t => {
  const temp = mkdtempSync(join(tmpdir(), "pi-code-review-"));
  const agentDir = join(temp, "home with spaces/.pi/agent");
  const project = join(temp, "neutral snapshot");
  const ledger = join(temp, "children.jsonl");
  const fakePi = join(temp, "fake-pi.mjs");
  const originalArgv = process.argv[1];
  const keys = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT", "PI_CODE_REVIEW_TEST_LOG", "PONYTAIL_DEFAULT_MODE"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    process.argv[1] = originalArgv;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(temp, { recursive: true, force: true });
  });

  for (const dir of ["agents", "prompts", "extensions"]) mkdirSync(join(agentDir, dir), { recursive: true });
  mkdirSync(project, { recursive: true });
  for (const name of agents) symlinkSync(join(source, "agents", name + ".md"), join(agentDir, "agents", name + ".md"));
  symlinkSync(join(source, "prompts/code-review.md"), join(agentDir, "prompts/code-review.md"));
  symlinkSync(join(source, "extensions/subagent"), join(agentDir, "extensions/subagent"), "dir");
  writeFileSync(fakePi, `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const task = args.at(-1);
const prompt = args[args.indexOf('--append-system-prompt') + 1];
const output = { args, task, prompt: readFileSync(prompt, 'utf8'), child: process.env.PI_SUBAGENT, ponytail: process.env.PONYTAIL_DEFAULT_MODE };
appendFileSync(process.env.PI_CODE_REVIEW_TEST_LOG, JSON.stringify({ event: 'start' }) + '\\n');
await new Promise(resolve => setTimeout(resolve, 100));
const failure = task === 'Task: FAIL';
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(output) }],
  model: 'fixture', provider: 'fixture', api: 'fixture', timestamp: Date.now(), stopReason: failure ? 'error' : 'stop',
  ...(failure ? { errorMessage: 'controlled fixture failure' } : {}),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } } }));
appendFileSync(process.env.PI_CODE_REVIEW_TEST_LOG, JSON.stringify({ event: 'end' }) + '\\n');
if (failure) process.exitCode = 2;
`);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODE_REVIEW_TEST_LOG = ledger;
  process.env.PONYTAIL_DEFAULT_MODE = "ultra";
  delete process.env.PI_SUBAGENT;
  process.argv[1] = fakePi;
  const makeLoader = () => new sdk.DefaultResourceLoader({
    cwd: project, agentDir,
    settingsManager: sdk.SettingsManager.inMemory({ packages: [] }),
    noContextFiles: true, noSkills: true, noThemes: true,
  });
  const loader = makeLoader();
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const definitions = loaded.extensions.flatMap(extension => [...extension.tools.values()]);
  assert.equal(definitions.length, 1);
  const subagent = definitions[0].definition;
  assert.equal(subagent.name, "subagent");
  assert.equal(subagent.exposure, "model-only");
  assert.equal(subagent.executionMode, "sequential");
  const prompts = loader.getPrompts();
  assert.deepEqual(prompts.diagnostics, []);
  assert.deepEqual(prompts.prompts.map(prompt => prompt.name), ["code-review"]);

  const ctx = { cwd: project, model: { provider: "fixture", id: "parent" }, thinkingLevel: "medium", hasUI: false, isProjectTrusted: () => false };
  const invoke = params => subagent.execute("fixture", params, undefined, undefined, ctx);
  await t.test("four reviewers queue with exactly two children at once", async () => {
    const result = await invoke({ tasks: agents.flatMap(agent => [
      { agent, task: "first independent review", cwd: project },
      { agent, task: "second independent review", cwd: project },
    ]) });
    assert.notEqual(result.isError, true);
    assert.equal(result.details.results.length, 4);
    for (const childResult of result.details.results) {
      assert.equal(childResult.exitCode, 0);
      const output = JSON.parse(childResult.messages.at(-1).content[0].text);
      const option = name => output.args[output.args.indexOf(name) + 1];
      assert.equal(option("--tools"), "read,grep,find,ls");
      assert.equal(option("--model"), models[agents.indexOf(childResult.agent)]);
      assert.equal(output.args.includes("--thinking"), false);
      assert.equal(output.args.includes("--no-mcp"), true);
      assert.equal(option("--exclude-tools"), "subagent,mcp__*,memory_*");
      assert.equal(output.child, "1");
      assert.equal(output.ponytail, "off");
      assert(output.prompt.includes("Não edite arquivos"));
      assert.equal(existsSync(option("--append-system-prompt")), false);
    }
    let active = 0;
    let maximum = 0;
    for (const event of readFileSync(ledger, "utf8").trim().split("\n").map(JSON.parse)) {
      active += event.event === "start" ? 1 : -1;
      maximum = Math.max(maximum, active);
    }
    assert.equal(active, 0);
    assert.equal(maximum, 2);
  });
  await t.test("unknown agents and oversized batches fail without invoking a model", async () => {
    assert.equal((await invoke({ agent: "missing-reviewer", task: "review" })).isError, true);
    const before = readFileSync(ledger, "utf8");
    const result = await invoke({ tasks: Array.from({ length: 9 }, () => ({ agent: agents[0], task: "review" })) });
    assert.equal(result.details.results.length, 0);
    assert.match(result.content[0].text, /Max is 8/);
    assert.equal(readFileSync(ledger, "utf8"), before);
  });
  await t.test("review failures remain visible instead of becoming clean results", async () => {
    const result = await invoke({ agent: agents[0], task: "FAIL" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /controlled fixture failure/);
  });
  await t.test("agent discovery accepts both YAML tool-list formats", async () => {
    const file = join(agentDir, "agents/code-review-rules.md");
    rmSync(file);
    copyFileSync(join(source, "agents/code-review-rules.md"), file);
    writeFileSync(file, readFileSync(file, "utf8").replace("tools: read, grep, find, ls", "tools: [read, grep, find, ls]"));
    const result = await invoke({ agent: agents[0], task: "YAML array fixture" });
    assert.notEqual(result.isError, true);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.args[output.args.indexOf("--tools") + 1], "read,grep,find,ls");
  });
  await t.test("child processes do not register recursive delegation", async () => {
    process.env.PI_SUBAGENT = "1";
    const child = makeLoader();
    await child.reload();
    assert.deepEqual(child.getExtensions().errors, []);
    assert(child.getExtensions().extensions.every(extension => !extension.tools.has("subagent")));
  });
});
