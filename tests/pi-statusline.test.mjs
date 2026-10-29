import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const install = join(homedir(), ".pi/agent/install");
const sdkDir = process.env.PI_SDK_DIR ?? join(install, "releases",
  (await readFile(join(install, "current-version"), "utf8")).trim(),
  "node_modules/@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(join(sdkDir, "dist/index.js")).href);
const { visibleWidth } = await import(pathToFileURL(resolve(sdkDir, "../pi-tui/dist/index.js")).href);
const { AssistantMessageEventStream } = await import(pathToFileURL(resolve(sdkDir, "../pi-ai/dist/index.js")).href);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const claude = { provider: "claude-bridge", id: "claude-opus-5-5", name: "Claude Opus" };
const codex = { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT Sol" };
const auto = { provider: "pi-auto-model", id: "auto", name: "Pi Auto Model" };
const planned = `Auto ON · ${claude.provider}/${claude.id} · balanced · general · ${claude.provider}/${claude.id}`;

async function harness(t, initial = auto) {
  const dir = await mkdtemp(join(tmpdir(), "pi-statusline-"));
  let footer;
  let renders = 0;
  let session;
  const errors = [];
  t.after(async () => {
    footer?.dispose?.();
    await session?.dispose();
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false,
  });
  for (const model of [claude, codex, auto]) runtime.registerProvider(model.provider, {
    baseUrl: "https://example.invalid", apiKey: "offline-test-key", api: "anthropic-messages",
    models: [{ ...model, reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const resources = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [join(root, "ai/pi/extensions/statusline.ts")],
  });
  await resources.reload();
  assert.deepEqual(resources.getExtensions().errors, []);
  ({ session } = await createAgentSession({
    cwd: dir, agentDir: dir, model: runtime.getModel(initial.provider, initial.id),
    modelRuntime: runtime, settingsManager: settings, resourceLoader: resources,
    sessionManager: SessionManager.inMemory(dir), noTools: true,
  }));
  const statuses = new Map();
  const theme = { fg: (_color, value) => value };
  await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error), uiContext: {
    theme,
    setFooter: (factory) => {
      footer?.dispose?.();
      footer = factory?.({ requestRender: () => renders++ }, theme, {
        getExtensionStatuses: () => statuses, getGitBranch: () => null, onBranchChange: () => () => {},
      });
    },
    setStatus: (key, value) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
    notify() {},
  } });
  return {
    session, statuses,
    render: (width = 500) => footer.render(width),
    renders: () => renders,
    select: (model) => session.setModel(runtime.getModel(model.provider, model.id)),
    emit: (type, event) => session.extensionRunner.emit({ type, ...event }),
  };
}

test("the footer shows a lock and jailed tag only for ai-jail", async (t) => {
  const originalPS1 = process.env.PS1;
  const originalJailed = process.env.PI_JAILED;
  t.after(() => {
    if (originalPS1 === undefined) delete process.env.PS1;
    else process.env.PS1 = originalPS1;
    if (originalJailed === undefined) delete process.env.PI_JAILED;
    else process.env.PI_JAILED = originalJailed;
  });
  const h = await harness(t, claude);
  for (const { prompt, marker, jailed } of [
    { prompt: "host $ ", marker: "1", jailed: true },
    { prompt: undefined, marker: undefined, jailed: false },
    { prompt: "host $ ", marker: "0", jailed: false },
    { prompt: "host $ ", marker: "true", jailed: false },
    { prompt: "(jailbreak) $ ", marker: undefined, jailed: false },
    { prompt: "(jail) \\w \\$ ", marker: undefined, jailed: true },
  ]) {
    if (prompt === undefined) delete process.env.PS1;
    else process.env.PS1 = prompt;
    if (marker === undefined) delete process.env.PI_JAILED;
    else process.env.PI_JAILED = marker;
    const line = h.render()[0];
    if (jailed) {
      assert.match(line, /^🔒 jailed \| 🤖 Claude Opus/);
      for (const width of [12, 40, 80]) {
        assert.match(h.render(width)[0], /^🔒 jailed/);
        assert.ok(h.render(width).every((row) => visibleWidth(row) <= width));
      }
    } else {
      assert.doesNotMatch(line, /🔒|jailed/);
      assert.match(line, /^🤖 Claude Opus/);
    }
  }
});

test("manual model switches update the installed footer immediately", async (t) => {
  const h = await harness(t, claude);
  assert.match(h.render()[0], /🤖 Claude Opus/);
  h.statuses.set("pi-auto-model", planned);
  await h.select(codex);
  assert.match(h.render()[0], /🤖 GPT Sol/);
  await h.select(claude);
  assert.match(h.render()[0], /🤖 Claude Opus/);
});

test("auto failover updates the footer from the physical provider stream, not the old plan", async (t) => {
  const h = await harness(t);
  h.statuses.set("pi-auto-model", planned);
  assert.match(h.render()[0], /claude-opus-5-5 \(auto\)/);
  const before = h.renders();
  await h.emit("provider_stream_event", { provider: codex.provider, model: codex.id, api: "anthropic-messages", data: {} });
  assert.match(h.render()[0], /gpt-6\.1-sol \(auto\)/);
  assert.ok(h.renders() > before);
  for (const width of [40, 80, 160]) assert.ok(h.render(width).every((line) => visibleWidth(line) <= width));
});

test("assistant messages update auto routing even without raw provider events", async (t) => {
  const h = await harness(t);
  h.statuses.set("pi-auto-model", planned);
  await h.emit("message_start", { message: { role: "assistant", provider: auto.provider, model: auto.id } });
  await h.emit("message_update", { message: { role: "assistant", provider: codex.provider, model: codex.id, thinkingLevel: "high" } });
  assert.match(h.render()[0], /gpt-6\.1-sol \(auto\).*💪 high/);
  await h.emit("message_end", { message: { role: "assistant", provider: claude.provider, model: claude.id } });
  assert.match(h.render()[0], /claude-opus-5-5 \(auto\)/);
  await h.emit("message_start", { message: { role: "assistant", provider: codex.provider, model: codex.id } });
  assert.match(h.render()[0], /gpt-6\.1-sol \(auto\)/);
});

test("a new run, model selection and tree navigation discard the previous live route", async (t) => {
  const h = await harness(t);
  h.statuses.set("pi-auto-model", planned);
  const stream = () => h.emit("provider_stream_event", { provider: codex.provider, model: codex.id, data: {} });
  await stream();
  assert.match(h.render()[0], /gpt-6\.1-sol \(auto\)/);
  await h.emit("before_agent_start", { messageType: "user", prompt: "next task" });
  assert.match(h.render()[0], /claude-opus-5-5 \(auto\)/);
  await stream();
  await h.select(claude);
  assert.match(h.render()[0], /🤖 Claude Opus/);
  await h.select(auto);
  assert.match(h.render()[0], /claude-opus-5-5 \(auto\)/);
  await stream();
  await h.emit("session_tree", {});
  assert.match(h.render()[0], /claude-opus-5-5 \(auto\)/);
});

test("same-provider model changes render once, and thinking selection remains live", async (t) => {
  const h = await harness(t);
  const event = { provider: codex.provider, model: codex.id, data: {} };
  await h.emit("provider_stream_event", event);
  const before = h.renders();
  await h.emit("provider_stream_event", event);
  assert.equal(h.renders(), before);
  await h.emit("provider_stream_event", { ...event, model: "gpt-5.6-luna" });
  assert.match(h.render()[0], /gpt-5\.6-luna \(auto\)/);
  await h.emit("message_update", { message: { role: "assistant", provider: codex.provider, model: "gpt-5.6-luna", thinkingLevel: "high" } });
  assert.match(h.render()[0], /💪 high/);
  h.session.setThinkingLevel("low");
  assert.match(h.render()[0], /💪 low/);
});

test("the real Pi loop and reload retain the physical response instead of the planned route", async (t) => {
  const h = await harness(t);
  h.session.setThinkingLevel("high");
  h.statuses.set("pi-auto-model", planned);
  h.session.agent.streamFunction = () => {
    const stream = new AssistantMessageEventStream();
    const message = {
      role: "assistant", provider: codex.provider, model: codex.id, api: "anthropic-messages",
      timestamp: Date.now(), thinkingLevel: "high", content: [{ type: "text", text: "OK" }], stopReason: "stop",
      usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  };
  await h.session.prompt("offline synthetic routing test");
  assert.equal(h.session.model.provider, auto.provider);
  assert.match(h.render()[0], /gpt-6\.1-sol \(auto\).*💪 high/);
  await h.emit("session_start", { reason: "reload" });
  assert.match(h.render()[0], /gpt-6\.1-sol \(auto\).*💪 high/);
});

test("wrapper and unrelated messages do not replace the physical auto route", async (t) => {
  const h = await harness(t);
  await h.emit("provider_stream_event", { provider: codex.provider, model: codex.id, data: {} });
  await h.emit("provider_stream_event", { provider: auto.provider, model: auto.id, data: {} });
  await h.emit("message_start", { message: { role: "assistant", provider: auto.provider, model: auto.id } });
  await h.emit("message_start", { message: { role: "user", content: "hello" } });
  assert.match(h.render()[0], /gpt-6\.1-sol \(auto\)/);
  await h.select(claude);
  await h.emit("provider_stream_event", { provider: codex.provider, model: codex.id, data: {} });
  assert.match(h.render()[0], /🤖 Claude Opus/);
});
