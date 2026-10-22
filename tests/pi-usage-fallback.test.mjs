import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import usageFallback from "../ai/pi/extensions/usage-fallback.ts";

const claude = { provider: "claude-bridge", id: "claude-opus-5-5" };
const sol = { provider: "openai-codex", id: "gpt-6.1-sol" };
const local = { provider: "ollama-local", id: "devstral-local" };
const quota = "Claude quota exceeded — rate limit (five_hour): You're out of extra usage";

function harness(errorMessage = quota, options = {}) {
  const handlers = new Map();
  const commands = new Map();
  const flags = new Map();
  const switches = [];
  const notifications = [];
  const journal = options.journal ?? [];
  const auth = new Map();
  const thinking = [];
  let model = options.model ?? claude;
  let idle = true;
  let level = "xhigh";
  const message = {
    role: "assistant", provider: claude.provider, model: claude.id,
    stopReason: "error", errorMessage, ...options.message,
  };
  const event = {
    outcome: options.outcome ?? "error",
    context: { contextEntries: [{ sourceEntry: { id: "failed-entry" }, messages: [message] }] },
  };
  const ctx = {
    get model() { return model; },
    signal: options.signal,
    hasUI: options.hasUI ?? true,
    isIdle: () => idle,
    hasPendingMessages: () => options.pending ?? false,
    sessionManager: { getBranch: () => journal },
    modelRegistry: { find: (provider, id) => options.missingModel ? undefined :
      [claude, sol, local, { ...claude, provider: "anthropic" }].find((m) => m.provider === provider && m.id === id) },
    ui: { notify: (text) => notifications.push(text), setStatus: () => {} },
  };
  usageFallback({
    on: (name, handler) => handlers.set(name, handler),
    registerFlag: (name, config) => flags.set(name, config.default),
    getFlag: (name) => options.flags?.[name] ?? flags.get(name),
    registerCommand: (name, command) => commands.set(name, command),
    getSettings: () => ({ defaultProvider: claude.provider, defaultModel: claude.id, defaultThinkingLevel: "xhigh" }),
    getThinkingLevel: () => level,
    setThinkingLevel: (value) => { level = value; thinking.push(value); },
    appendEntry: (customType, data) => journal.push({ type: "custom", customType, data: structuredClone(data) }),
    setModel: async (next) => {
      if (options.auth === false || auth.get(next.provider) === false) return false;
      const previousModel = model;
      model = next;
      switches.push(next);
      await handlers.get("model_select")?.({ model: next, previousModel, source: "set" }, ctx);
      return true;
    },
  });
  return {
    run: (override = {}) => handlers.get("agent_before_settle")({ ...event, ...override }, ctx),
    start: () => handlers.get("session_start")({}, ctx),
    shutdown: () => handlers.get("session_shutdown")({}, ctx),
    tick: () => handlers.get("input")({}, ctx),
    headers: (headers) => handlers.get("after_provider_response")({ headers, status: 429 }, ctx),
    command: (args) => commands.get("claude-return").handler(args, ctx),
    manualModel: async (next) => {
      const previousModel = model;
      model = next;
      await handlers.get("model_select")({ model: next, previousModel, source: "set" }, ctx);
    },
    setIdle: (value) => { idle = value; },
    switches, notifications, journal, auth, thinking, ctx,
  };
}

for (const error of [
  quota, "You've hit your limit · resets 6pm", "You’re out of extra usage",
  "You have reached your usage limit", "usage_limit_reached", "quota_exceeded",
  "Monthly usage limit reached", "5-hour limit exceeded",
]) {
  test(`switches on Claude usage exhaustion: ${error}`, async () => {
    const h = harness(error);
    assert.deepEqual(await h.run(), {
      continue: true,
      entries: [{ type: "context_edit", targetId: "failed-entry", replacement: null }],
    });
    assert.deepEqual(h.switches, [sol]);
    assert.equal(h.notifications.length, 1);
  });
}

for (const error of [
  "429 rate limit: too many requests per minute", "503 overloaded", "fetch failed",
  "401 Unauthorized", "Invalid API key", "prompt is too long", "context limit exceeded",
]) {
  test(`does not switch on unrelated errors: ${error}`, async () => {
    const h = harness(error);
    assert.equal(await h.run(), undefined);
    assert.equal(h.switches.length, 0);
  });
}

for (const options of [
  { outcome: "completed" }, { outcome: "aborted" },
  { signal: AbortSignal.abort() }, { model: sol },
  { message: { provider: "openai-codex", model: sol.id } },
  { message: { stopReason: "stop" } },
  { message: { errorMessage: undefined } },
]) {
  test(`does not continue an ineligible run: ${JSON.stringify(options)}`, async () => {
    const h = harness(quota, options);
    assert.equal(await h.run(), undefined);
    assert.equal(h.switches.length, 0);
  });
}

for (const options of [{ missingModel: true }, { auth: false }]) {
  test(`keeps the original error when fallback is unavailable: ${JSON.stringify(options)}`, async () => {
    const h = harness(quota, options);
    assert.equal(await h.run(), undefined);
    assert.equal(h.notifications.length, 1);
  });
}

test("also handles Claude accessed through the Anthropic provider", async () => {
  const h = harness(quota, {
    model: { ...claude, provider: "anthropic" }, message: { provider: "anthropic" },
  });
  assert.equal((await h.run()).continue, true);
});

test("non-interactive runs do not depend on UI", async () => {
  const h = harness(quota, { hasUI: false });
  assert.equal((await h.run()).continue, true);
  assert.equal(h.notifications.length, 0);
});

test("real Pi loop falls back and returns without replaying tools or changing defaults", async (t) => {
  // The official installer keeps the SDK in a versioned directory. npm installs
  // can point PI_SDK_DIR at their @earendil-works/pi-coding-agent directory.
  const install = join(homedir(), ".pi/agent/install");
  const sdkDir = process.env.PI_SDK_DIR ?? join(
    install, "releases", (await readFile(join(install, "current-version"), "utf8")).trim(),
    "node_modules/@earendil-works/pi-coding-agent",
  );
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
    await import(pathToFileURL(join(sdkDir, "dist/index.js")).href);
  const { AssistantMessageEventStream } = await import(pathToFileURL(
    resolve(sdkDir, "../pi-ai/dist/index.js"),
  ).href);
  const dir = await mkdtemp(join(tmpdir(), "pi-fallback-test-"));
  let session;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false,
    });
    for (const model of [claude, sol]) {
      runtime.registerProvider(model.provider, {
        baseUrl: "https://example.invalid", apiKey: "offline-test-key", api: "anthropic-messages",
        models: [{ id: model.id, name: model.id, reasoning: false, input: ["text"],
          contextWindow: 200_000, maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      });
    }
    const settings = SettingsManager.inMemory({
      defaultProvider: claude.provider, defaultModel: claude.id,
      retry: { enabled: false }, compaction: { enabled: false },
    });
    const resources = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [usageFallback],
    });
    await resources.reload();
    assert.deepEqual(resources.getExtensions().errors, []);
    let toolExecutions = 0;
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, model: runtime.getModel(claude.provider, claude.id),
      modelRuntime: runtime, resourceLoader: resources, settingsManager: settings,
      sessionManager: SessionManager.inMemory(dir), noTools: true,
      customTools: [{
        name: "once", label: "Once", description: "Offline test counter",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          toolExecutions++;
          return { content: [{ type: "text", text: "already done" }], details: undefined };
        },
      }],
    }));
    const errors = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    const calls = [];
    let solExhausted = false;
    session.agent.streamFunction = (model, context) => {
      calls.push(model.provider);
      const index = calls.length;
      const failed = index === 2 || solExhausted;
      if (model.provider === sol.provider) {
        assert.ok(context.messages.some((m) => m.role === "toolResult" && m.toolName === "once"));
        assert.ok(!context.messages.some((m) => m.role === "assistant" && m.stopReason === "error"));
      }
      const result = {
        role: "assistant", provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(),
        content: index === 1
          ? [{ type: "toolCall", id: "once-call", name: "once", arguments: {} }]
          : failed ? [] : [{ type: "text", text: "OK" }],
        stopReason: index === 1 ? "toolUse" : failed ? "error" : "stop",
        ...(failed ? { errorMessage: quota } : {}),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "start", partial: result });
      stream.push(result.stopReason === "error"
        ? { type: "error", reason: "error", error: result }
        : { type: "done", reason: result.stopReason, message: result });
      stream.end();
      return stream;
    };
    await session.prompt("Continue the offline test");
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, [claude.provider, claude.provider, sol.provider]);
    assert.equal(session.getLastAssistantText(), "OK");
    assert.equal(toolExecutions, 1);
    assert.equal(session.model.id, sol.id);
    assert.equal(settings.getDefaultModel(), claude.id);
    const branch = session.sessionManager.getBranch();
    assert.ok(branch.some((e) => e.type === "message" && e.message.errorMessage === quota));
    assert.ok(branch.some((e) => e.type === "context_edit" && e.replacement === null));
    assert.equal(session.sessionManager.buildSessionContext().model.modelId, sol.id);
    await session.prompt("Continue on the same model");
    assert.equal(calls.at(-1), sol.provider);
    assert.equal(toolExecutions, 1);
    solExhausted = true;
    const count = calls.length;
    await session.prompt("Sol also runs out of quota");
    assert.equal(calls.length, count + 1);
    assert.equal(session.model.id, sol.id);
    assert.equal(session.messages.at(-1).stopReason, "error");
    assert.equal(toolExecutions, 1);
    assert.deepEqual(errors, []);

    const pending = session.sessionManager.getBranch().findLast((e) => e.type === "custom" && e.customType === "claude-quota-return");
    assert.equal(pending.data.phase, "waiting");
    t.mock.method(Date, "now", () => pending.data.nextAt);
    const beforeReturn = calls.length;
    await session._extensionRunner.emit({ type: "input", text: "next real task", source: "interactive" });
    assert.equal(session.model.id, claude.id);
    assert.equal(calls.length, beforeReturn, "selecting Claude must not send a probe prompt");
    solExhausted = false;
    await session.prompt("Continue the original task after quota reset");
    assert.equal(calls.length, beforeReturn + 1);
    assert.equal(calls.at(-1), claude.provider);
    assert.equal(toolExecutions, 1);
    assert.equal(settings.getDefaultModel(), claude.id);
    assert.equal(session.sessionManager.getBranch().findLast((e) => e.type === "custom" && e.customType === "claude-quota-return").data, null);
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

function clock(t) {
  let now = Date.UTC(2026, 9, 20, 12);
  t.mock.method(Date, "now", () => now);
  return { advance: (ms) => { now += ms; }, set: (ms) => { now = ms; }, now: () => now };
}

const pending = (h) => h.journal.at(-1)?.data;

function windows(now, weekly = 0.2) {
  return {
    "Anthropic-Ratelimit-Unified-5h-Utilization": "1",
    "Anthropic-Ratelimit-Unified-5h-Reset": String((now + 3600_000) / 1000),
    "anthropic-ratelimit-unified-7d-utilization": String(weekly),
    "anthropic-ratelimit-unified-7d-reset": String((now + 3 * 86400_000) / 1000),
  };
}

test("returns after the blocking reset plus grace, without probe requests", async (t) => {
  const c = clock(t);
  const h = harness();
  h.headers(windows(c.now()));
  await h.run();
  assert.equal(pending(h).nextAt, c.now() + 3600_000 + 60_000);
  await h.tick();
  assert.deepEqual(h.switches, [sol]);
  c.set(pending(h).nextAt);
  await h.tick();
  assert.deepEqual(h.switches, [sol, claude]);
  assert.deepEqual(h.thinking, ["xhigh"]);
  assert.equal(pending(h).phase, "trying");
  await h.run({ outcome: "completed" });
  assert.equal(pending(h), null);
});

test("waits for the latest blocked window, including weekly quota", async (t) => {
  const c = clock(t);
  const h = harness();
  h.headers(windows(c.now(), 1));
  await h.run();
  assert.equal(pending(h).nextAt, c.now() + 3 * 86400_000 + 60_000);
});

test("respects rejected status even below rounded 100 percent", async (t) => {
  const c = clock(t);
  const h = harness();
  h.headers({ ...windows(c.now(), 0.99), "anthropic-ratelimit-unified-7d-status": "rejected" });
  await h.run();
  assert.equal(pending(h).nextAt, c.now() + 3 * 86400_000 + 60_000);
});

test("unknown or stale reset waits five minutes instead of retrying immediately", async (t) => {
  const c = clock(t);
  const h = harness();
  h.headers({ "anthropic-ratelimit-unified-5h-reset": "not-a-date" });
  await h.run();
  assert.equal(pending(h).nextAt, c.now() + 300_000);
});

test("repeated quota errors use 5, 10, 20 and 30 minute backoff", async (t) => {
  const c = clock(t);
  const h = harness();
  await h.run();
  for (const minutes of [5, 10, 20, 30, 30]) {
    c.set(pending(h).nextAt);
    await h.tick();
    assert.equal(h.ctx.model.id, claude.id);
    await h.run();
    assert.equal(h.ctx.model.id, sol.id);
    assert.equal(pending(h).nextAt - c.now(), minutes * 60_000);
  }
});

test("defers return while running tools or waiting on queued work", async (t) => {
  const c = clock(t);
  const options = { pending: false };
  const h = harness(quota, options);
  await h.run();
  c.set(pending(h).nextAt);
  h.setIdle(false);
  await h.tick();
  assert.deepEqual(h.switches, [sol]);
  h.setIdle(true);
  options.pending = true;
  await h.tick();
  assert.deepEqual(h.switches, [sol]);
  options.pending = false;
  await h.tick();
  assert.deepEqual(h.switches, [sol, claude]);
});

test("manual model selection cancels automatic return", async (t) => {
  const c = clock(t);
  const h = harness();
  await h.run();
  const deadline = pending(h).nextAt;
  await h.manualModel(local);
  assert.deepEqual(pending(h), { disabled: true });
  c.set(deadline);
  await h.tick();
  assert.deepEqual(h.switches, [sol]);
  assert.equal(h.ctx.model.id, local.id);
});

test("off persists through reload and does not rearm on another quota failure", async (t) => {
  const c = clock(t);
  const h = harness();
  await h.run();
  await h.command("off");
  const resumed = harness(quota, { model: sol, journal: h.journal, flags: { "wait-claude": true } });
  t.after(resumed.shutdown);
  await resumed.start();
  c.advance(3600_000);
  await resumed.tick();
  assert.deepEqual(resumed.switches, []);
  await resumed.manualModel(claude);
  await resumed.run();
  assert.equal(resumed.ctx.model.id, sol.id);
  assert.deepEqual(pending(resumed), { disabled: true });
});

test("restores the wait from the active session branch", async (t) => {
  const c = clock(t);
  const h = harness();
  await h.run();
  const resumed = harness(quota, { model: sol, journal: h.journal });
  t.after(resumed.shutdown);
  c.set(pending(h).nextAt);
  await resumed.start();
  assert.deepEqual(resumed.switches, [claude]);
});

test("invalid persisted metadata cannot select a model", async (t) => {
  clock(t);
  const h = harness(quota, { model: sol, journal: [{ type: "custom", customType: "claude-quota-return", data: {
    target: { provider: "untrusted", id: "remote" }, fallback: sol, nextAt: 1, phase: "waiting", attempts: 0, thinking: "high",
  } }] });
  t.after(h.shutdown);
  await h.start();
  await h.tick();
  assert.deepEqual(h.switches, []);
});

test("failed authentication keeps the fallback and retries selection later", async (t) => {
  const c = clock(t);
  const h = harness();
  await h.run();
  c.set(pending(h).nextAt);
  h.auth.set(claude.provider, false);
  await h.tick();
  assert.equal(h.ctx.model.id, sol.id);
  assert.equal(pending(h).nextAt, c.now() + 300_000);
  c.set(pending(h).nextAt);
  h.auth.set(claude.provider, true);
  await h.tick();
  assert.equal(h.ctx.model.id, claude.id);
});

test("shutdown releases the timer without cancelling a persisted wait", async (t) => {
  const c = clock(t);
  const h = harness();
  await h.start();
  await h.run();
  const before = structuredClone(pending(h));
  h.shutdown();
  c.set(before.nextAt);
  await h.tick();
  assert.deepEqual(h.switches, [sol]);
  assert.deepEqual(pending(h), before);
});

test("local profile returns to Claude and falls back to Devstral if still blocked", async (t) => {
  const c = clock(t);
  const h = harness(quota, { model: local, flags: { "wait-claude": true, "usage-fallback": "ollama-local/devstral-local" } });
  t.after(h.shutdown);
  await h.start();
  assert.equal(pending(h).fallback.id, local.id);
  c.set(pending(h).nextAt);
  await h.tick();
  assert.equal(h.ctx.model.id, claude.id);
  await h.run();
  assert.equal(h.ctx.model.id, local.id);
  assert.equal(pending(h).nextAt - c.now(), 300_000);
});

test("plain local sessions never enable cloud return implicitly", async (t) => {
  const c = clock(t);
  const h = harness(quota, { model: local });
  t.after(h.shutdown);
  await h.start();
  c.advance(86400_000);
  await h.tick();
  assert.deepEqual(h.switches, []);
  assert.equal(h.ctx.model.id, local.id);
});
