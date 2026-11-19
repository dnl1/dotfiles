import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { OVERRIDES } from "../ai/pi/lib/claude-accounts.ts";

const codexQuota = "Codex usage limit reached (plus plan). Resets in ~30m.";

async function realSession({ rotation, solFails, auto = false, failAllClaude = false }, run) {
  const dir = mkdtempSync(join(tmpdir(), "pi-real-rotation-"));
  const saved = new Map(["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR", ...OVERRIDES].map((key) => [key, process.env[key]]));
  for (const key of OVERRIDES) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = dir;
  const work = join(dir, "work"), personal = join(dir, "personal");
  mkdirSync(work); mkdirSync(personal);
  process.env.CLAUDE_CONFIG_DIR = work;
  mkdirSync(join(dir, "npm/node_modules"), { recursive: true });
  const bridgeRoot = join(homedir(), ".pi/agent/npm/node_modules/pi-claude-bridge");
  const routerRoot = join(homedir(), ".pi/agent/packages/pi-routing-compat/vendor/pi-auto-model");
  const installRoot = join(homedir(), ".pi/agent/install");
  if (auto) {
    process.env.HOME = dir;
    delete process.env.USERPROFILE;
    mkdirSync(join(dir, ".pi/agent"), { recursive: true });
    const config = auto === "configured" ? JSON.parse(readFileSync(resolve("ai/pi/auto-model.json"), "utf8")) : {
      rules: [{ name: "offline", when: {}, then: {
        only: auto === "claude-only" ? ["claude-bridge/claude-opus-5-5"] : ["claude-bridge/claude-opus-5-5", "openai-codex/gpt-6.1-sol"],
        prefer: ["claude-bridge/claude-opus-5-5"],
      } }],
    };
    writeFileSync(join(dir, ".pi/agent/auto-model.json"), JSON.stringify({ ...config,
      enabled: true, constraints: { providerAllow: ["claude-bridge", "openai-codex", "opencode-cli"] },
      pricing: { ...config.pricing, litellm: { enabled: false } }, classifier: { enabled: false },
    }));
  }
  symlinkSync(bridgeRoot, join(dir, "npm/node_modules/pi-claude-bridge"));
  writeFileSync(join(dir, "claude-accounts.json"), JSON.stringify({
    trabalho: { directory: work, expectedEmail: "work@example.test" },
    pessoal: { directory: personal, expectedEmail: "personal@example.test" },
    rotation,
  }));
  writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify({ provider: { plan: "pro" }, startupNoticeShown: true }));
  const key = `pi-rotation-test-${Date.now()}`;
  const calls = [];
  globalThis[key] = calls;
  // Two extensions, as Pi loads them from ~/.pi/agent/extensions: each sees only
  // the flags it registered, so the fallback cannot read the adapter's flag.
  const fixture = join(dir, "fixture-adapter.ts");
  const fallbackFixture = join(dir, "fixture-fallback.ts");
  writeFileSync(fallbackFixture, `
import fallback from ${JSON.stringify(resolve("ai/pi/extensions/usage-fallback.ts"))};
const personal = ${JSON.stringify(personal)};
export default function(pi) {
  fallback(new Proxy(pi, { get(target, property) {
    if (property === "exec") return async (_command, args) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { code: 0, stdout: JSON.stringify({
        loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro",
        email: args[0] === "CLAUDE_CONFIG_DIR=" + personal ? "personal@example.test" : "work@example.test",
      }) };
    };
    return target[property];
  } }));
}
`);
  writeFileSync(fixture, `
import adapter from ${JSON.stringify(resolve("ai/pi/extensions/claude-bridge-accounts.ts"))};
import { __test } from ${JSON.stringify(join(bridgeRoot, "src/index.ts"))};
${auto ? `import registerAutoModel from ${JSON.stringify(join(routerRoot, "extensions/auto-model.ts"))};` : ""}
const calls = globalThis[${JSON.stringify(key)}];
const work = ${JSON.stringify(work)};
const personal = ${JSON.stringify(personal)};
const counts = new Map();
const workId = "11111111-1111-4111-8111-111111111111";
const personalId = "22222222-2222-4222-8222-222222222222";
export default async function(pi) {
  __test.setQuery((request) => {
    const directory = request.options.env.CLAUDE_CONFIG_DIR;
    const count = (counts.get(directory) ?? 0) + 1;
    counts.set(directory, count);
    calls.push({ directory, resume: request.options.resume });
    const failed = ${failAllClaude} || count > 1;
    const session_id = directory === work ? workId : personalId;
    const iterator = (async function*() {
      yield { type: "system", subtype: "init", session_id };
      if (!failed) yield { type: "assistant", message: {
        id: "message-" + calls.length, role: "assistant", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 1, output_tokens: 1 },
      } };
      yield failed
        ? { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Claude quota exceeded: You're out of extra usage"], session_id }
        : { type: "result", subtype: "success", is_error: false, result: "", session_id };
    })();
    iterator.close = () => {};
    iterator.interrupt = async () => {};
    return iterator;
  });
  await adapter(pi);
  ${auto ? "registerAutoModel(pi);" : ""}
  pi.on("session_shutdown", () => __test.setQuery(null));
}
`);
  let session, solCalls = 0;
  try {
    const install = installRoot;
    const sdkDir = process.env.PI_SDK_DIR ?? join(install, "releases", readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules/@earendil-works/pi-coding-agent");
    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(sdkDir, "dist/index.js")).href);
    const { AssistantMessageEventStream } = await import(pathToFileURL(resolve(sdkDir, "../pi-ai/dist/index.js")).href);
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
    const fallbackProvider = {
      baseUrl: "https://example.invalid", apiKey: "offline", api: "offline-sol",
      models: ["gpt-6.1-sol", ...(auto === "configured" ? ["gpt-6-luna"] : [])].map(id => ({ id, name: "offline " + id, reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      streamSimple: (model, context) => {
        assert.ok(!context.messages.some((m) => m.role === "assistant" && m.stopReason === "error"));
        solCalls++;
        calls.push({ directory: model.id === "gpt-6.1-sol" ? "Sol" : model.id });
        const failed = solFails && solCalls === 1;
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: failed ? [] : [{ type: "text", text: "Sol OK" }], timestamp: Date.now(), stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage: codexQuota } : {}), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = new AssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push(failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message });
        stream.end();
        return stream;
      },
    };
    runtime.registerProvider("openai-codex", fallbackProvider);
    if (auto === "configured") runtime.registerProvider("opencode-cli", {
      ...fallbackProvider, models: [{ ...fallbackProvider.models[0], id: "opencode/big-pickle" }],
    });
    const settings = SettingsManager.inMemory({ defaultProvider: "claude-bridge", defaultModel: "claude-opus-5-5", retry: { enabled: false }, compaction: { enabled: false } });
    const resources = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, additionalExtensionPaths: [fixture, fallbackFixture] });
    await resources.reload();
    assert.deepEqual(resources.getExtensions().errors, []);
    for (const registration of resources.getExtensions().runtime.pendingProviderRegistrations) runtime.registerProvider(registration.name, registration.config);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, model: runtime.getModel(auto ? "pi-auto-model" : "claude-bridge", auto ? "auto" : "claude-opus-5-5"), modelRuntime: runtime, resourceLoader: resources, settingsManager: settings, sessionManager: SessionManager.inMemory(dir), noTools: true }));
    const errors = [];
    await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error) });
    await run({ session, calls, errors, settings, work, personal, solCalls: () => solCalls });
  } finally {
    session?.dispose();
    delete globalThis[key];
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("real Pi and bridge use separate Claude sessions across quota rotation (offline SDK transport)", () => realSession(
  { rotation: ["trabalho", "pessoal"], solFails: false },
  async ({ session, calls, errors, settings, work, personal }) => {
    await session.prompt("First work request");
    assert.equal(session.getLastAssistantText(), "OK");
    await session.prompt("Work quota exhausted; continue on personal");
    assert.equal(session.getLastAssistantText(), "OK");
    assert.deepEqual(calls.map((call) => call.directory), [work, work, personal]);
    assert.notEqual(calls[2].resume, "11111111-1111-4111-8111-111111111111", "personal must never resume work's Claude Code session");
    await session.prompt("Personal quota exhausted; continue on Sol");
    assert.equal(session.getLastAssistantText(), "Sol OK");
    assert.equal(session.model.provider, "openai-codex");
    assert.deepEqual(errors, []);
    assert.equal(settings.getDefaultProvider(), "claude-bridge");
    assert.equal(session.sessionManager.getSessionId().includes("claude-account"), false);
  },
));

test("real Pi loop with fallback in the middle: work -> Sol -> personal in one request (offline SDK transport)", () => realSession(
  { rotation: ["trabalho", "fallback", "pessoal"], solFails: true },
  async ({ session, calls, errors, settings, work, personal, solCalls }) => {
    await session.prompt("First work request");
    await session.prompt("Work and Sol exhausted; continue on personal");
    assert.equal(session.getLastAssistantText(), "OK");
    assert.equal(solCalls(), 1);
    assert.deepEqual(calls.filter((call) => call.directory !== "Sol").map((call) => call.directory), [work, work, personal]);
    assert.notEqual(calls.at(-1).resume, "11111111-1111-4111-8111-111111111111", "personal must never resume work's Claude Code session");
    assert.equal(session.model.provider, "claude-bridge");
    assert.equal(process.env.CLAUDE_CONFIG_DIR, personal);
    assert.deepEqual(errors, []);
    assert.equal(settings.getDefaultProvider(), "claude-bridge");
  },
));

test("real Auto Claude-only plan survives delayed subscription verification", () => realSession(
  { rotation: ["trabalho", "pessoal"], solFails: false, auto: "claude-only" },
  async ({ session, calls, errors, work, personal }) => {
    await session.prompt("Reply OK");
    calls.length = 0;
    await session.prompt("Reply OK again");
    assert.equal(session.getLastAssistantText(), "OK", JSON.stringify(session.state.messages.at(-1)));
    assert.deepEqual(calls.map((call) => call.directory), [work, personal]);
    assert.equal(session.model.provider, "pi-auto-model");
    assert.deepEqual(errors, []);
  },
));

test("configured Auto exhausts both Claude accounts before Sol, not Luna or Big Pickle", () => realSession(
  { rotation: ["trabalho", "pessoal"], solFails: false, auto: "configured", failAllClaude: true },
  async ({ session, calls, errors, work, personal }) => {
    await session.prompt("Reply after both Claude subscriptions hit their limit");
    assert.equal(session.getLastAssistantText(), "Sol OK", JSON.stringify(calls));
    assert.deepEqual(calls.map((call) => call.directory), [work, personal, "Sol"]);
    assert.deepEqual(errors, []);
  },
));

test("real Auto request tries work, personal, then Sol without losing its route plan", () => realSession(
  { rotation: ["trabalho", "pessoal"], solFails: false, auto: true },
  async ({ session, calls, errors, work, personal }) => {
    await session.prompt("Reply OK");
    assert.equal(session.getLastAssistantText(), "OK", JSON.stringify({ calls, errors, messages: session.state.messages }));
    calls.length = 0;
    await session.prompt("Reply OK again");
    assert.equal(session.getLastAssistantText(), "OK", JSON.stringify(calls));
    assert.deepEqual(calls.map((call) => call.directory), [work, personal]);
    assert.notEqual(calls[1].resume, "11111111-1111-4111-8111-111111111111");
    calls.length = 0;
    await session.prompt("Reply after both subscriptions are exhausted");
    assert.equal(session.getLastAssistantText(), "Sol OK", JSON.stringify(calls));
    assert.deepEqual(calls.map((call) => call.directory), [personal, "Sol"]);
    assert.equal(session.model.provider, "pi-auto-model");
    assert.deepEqual(errors, []);
  },
));
