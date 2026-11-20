import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const install = join(homedir(), ".pi/agent/install/releases/1.5.2/node_modules");
const sdk = await import(pathToFileURL(join(install, "@earendil-works/pi-coding-agent/dist/index.js")));
const ai = await import(pathToFileURL(join(install, "@earendil-works/pi-ai/dist/index.js")));
const router = process.env.PI_ROUTING_PACKAGE ?? join(homedir(), ".pi/agent/packages/pi-routing-compat");

async function request({ tokens, windows = [500_000, 1_000_000], pool = false, compact = false, prompt = "Continue the task." }, check) {
  const dir = mkdtempSync(join(tmpdir(), "pi-capacity-"));
  const saved = new Map(["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
  const calls = [], events = [], errors = [];
  let session;
  try {
    process.env.HOME = dir;
    delete process.env.USERPROFILE;
    process.env.PI_CODING_AGENT_DIR = dir;
    const agentDir = join(dir, ".pi/agent");
    mkdirSync(agentDir, { recursive: true });
    const ids = windows.map((_, i) => `fixture-models/model-${i}`);
    writeFileSync(join(agentDir, "auto-model.json"), JSON.stringify({
      enabled: true, constraints: { providerAllow: ["fixture-models"] }, classifier: { enabled: false },
      pricing: { litellm: { enabled: false } }, rules: [{ name: "preferred-small", when: {}, then: { prefer: [ids[0]] } }],
      ...(pool ? { pool: "small", pools: { small: { targets: [{ id: ids[0], weight: 1 }], fallback: "any" } } } : {}),
    }));
    const fixture = join(dir, "router.ts");
    writeFileSync(fixture, `import auto from ${JSON.stringify(join(router, "vendor/pi-auto-model/extensions/auto-model.ts"))}; export default auto;`);
    const runtime = await sdk.ModelRuntime.create({
      credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} },
      modelsPath: null, refreshOnCreate: false,
    });
    runtime.registerProvider("fixture-models", {
      apiKey: "fixture", api: "fixture-api", baseUrl: "https://fixture.invalid",
      models: windows.map((contextWindow, i) => ({ id: `model-${i}`, name: `Model ${i}`, contextWindow, maxTokens: 128_000,
        reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })),
      streamSimple(model, context, options) {
        calls.push({ model: model.id, maxTokens: options.maxTokens, context });
        const stream = ai.createAssistantMessageEventStream();
        const message = { role: "assistant", provider: model.provider, api: model.api, model: model.id,
          content: [{ type: "text", text: "CAPACITY_OK" }], stopReason: "stop", timestamp: Date.now(),
          usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        return stream;
      },
    });
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: compact, reserveTokens: 4096, keepRecentTokens: 1024 }, retry: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir, settingsManager: settings,
      additionalExtensionPaths: [fixture], noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = sdk.SessionManager.inMemory(dir);
    manager.appendMessage({ role: "user", content: "Completed earlier work. ".repeat(400), timestamp: Date.now() - 4 });
    manager.appendMessage({ role: "assistant", provider: "fixture-models", api: "fixture-api", model: "model-0",
      content: [{ type: "text", text: "Completed." }], stopReason: "stop", timestamp: Date.now() - 3,
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    manager.appendMessage({ role: "user", content: "Earlier work; retain the task and its constraints. ".repeat(400), timestamp: Date.now() - 2 });
    manager.appendMessage({ role: "assistant", provider: "fixture-models", api: "fixture-api", model: "model-0",
      content: [{ type: "text", text: "Earlier result." }], stopReason: "stop", timestamp: Date.now() - 1,
      usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    sdk.initTheme("dark", false);
    ({ session } = await sdk.createAgentSession({ cwd: dir, agentDir, modelRuntime: runtime,
      model: runtime.getModel("fixture-models", "model-0"), settingsManager: settings,
      resourceLoader: loader, sessionManager: manager, noTools: "all" }));
    await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
    session.subscribe(event => events.push(event));
    const timer = setTimeout(() => void session.abort(), 15_000);
    try { await session.prompt(prompt); } finally { clearTimeout(timer); }
    await check({ calls, events, errors, session, manager });
  } finally {
    session?.dispose();
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
}

function succeeded({ session, errors }) {
  assert.deepEqual(errors, []);
  const last = session.messages.findLast(message => message.role === "assistant");
  assert.equal(last?.stopReason, "stop", last?.errorMessage);
  assert.equal(last?.content[0]?.text, "CAPACITY_OK");
}

test("Auto moves to a larger registered model when the preferred model cannot fit", async () => {
  await request({ tokens: 600_000 }, result => {
    succeeded(result);
    assert.equal(result.calls.at(-1)?.model, "model-1");
  });
});

test("Auto's any-pool fallback includes context capacity, not only quota", async () => {
  await request({ tokens: 600_000, pool: true }, result => {
    succeeded(result);
    assert.equal(result.calls.at(-1)?.model, "model-1");
  });
});

test("Auto reduces optional output to the model's remaining capacity", async () => {
  await request({ tokens: 866_085, windows: [1_000_000], prompt: "Commit and push the routing fixes" }, result => {
    succeeded(result);
    const call = result.calls.at(-1);
    assert.ok(call.maxTokens >= 2048 && call.maxTokens < 4000, String(call.maxTokens));
  });
});

test("Auto reports a context overflow rather than losing its approved plan", async () => {
  await request({ tokens: 900_000, windows: [1_000_000] }, ({ session, calls }) => {
    assert.equal(calls.length, 0);
    assert.match(session.messages.findLast(message => message.role === "assistant")?.errorMessage ?? "", /context_length_exceeded/);
  });
});

test("Auto preserves an explicit model pin through overflow compaction", async () => {
  await request({ tokens: 900_000, windows: [1_000_000, 1_000_000], compact: true,
    prompt: "@model:fixture-models/model-1 Continue the pinned task." }, result => {
    succeeded(result);
    assert.equal(result.calls.at(-1)?.model, "model-1");
    assert.ok(!JSON.stringify(result.calls.at(-1)?.context.messages.at(-1)).includes("@model:"));
  });
});

test("Auto compacts once and replans when no registered model has enough capacity", async () => {
  await request({ tokens: 900_000, windows: [1_000_000], compact: true }, result => {
    succeeded(result);
    assert.equal(result.manager.getBranch().filter(entry => entry.type === "compaction").length, 1);
    assert.ok(result.events.some(event => event.type === "compaction_end" && event.willRetry));
    assert.ok(result.calls.length >= 2);
  });
});
