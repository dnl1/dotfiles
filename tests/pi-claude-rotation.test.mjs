import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import usageFallback from "../ai/pi/extensions/usage-fallback.ts";
import { bridgeAPI, accountSessionId } from "../ai/pi/extensions/claude-bridge-accounts.ts";
import { ACCOUNT_CHANGED, OVERRIDES, accountConfig } from "../ai/pi/lib/claude-accounts.ts";

const claude = { provider: "claude-bridge", id: "claude-opus-5-5" };
const sol = { provider: "openai-codex", id: "gpt-6.1-sol" };
const quota = "Claude quota exceeded: You're out of extra usage";
const codexQuota = "Codex usage limit reached (plus plan). Resets in ~30m. Current limit: 5h 100%, weekly 40%.";
const middle = ["trabalho", "fallback", "pessoal"];
const omitted = { continue: true, entries: [{ type: "context_edit", targetId: "failed-entry", replacement: null }] };
const last = (h, name = "claude-quota-return") => h.journal.findLast((e) => e.customType === name)?.data;

function harness(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-rotation-"));
  const saved = new Map(["PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR", ...OVERRIDES].map((key) => [key, process.env[key]]));
  for (const key of OVERRIDES) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.CLAUDE_CONFIG_DIR;
  const personal = join(dir, "personal");
  mkdirSync(personal);
  const config = {
    trabalho: { directory: null, expectedEmail: "work@example.test" },
    pessoal: { directory: personal, expectedEmail: "personal@example.test" },
    rotation: options.rotation ?? ["trabalho", "pessoal"],
  };
  const writeConfig = () => writeFileSync(join(dir, "claude-accounts.json"), JSON.stringify(config));
  writeConfig();
  const handlers = new Map();
  const commands = new Map();
  const flags = new Map();
  const switches = [], notifications = [], executions = [], journal = options.journal ?? [];
  const statuses = new Map();
  const bus = new EventEmitter();
  const events = { emit: (name, value) => bus.emit(name, value), on: (name, fn) => { bus.on(name, fn); return () => bus.off(name, fn); } };
  let model = options.model ?? claude;
  let level = "xhigh", idle = true, pending = false;
  const ctx = {
    get model() { return model; }, signal: options.signal,
    hasUI: options.hasUI ?? true, mode: "tui", cwd: dir,
    isIdle: () => idle, hasPendingMessages: () => pending,
    sessionManager: { getBranch: () => journal, getSessionId: () => "original-session" },
    modelRegistry: { find: (provider, id) => options.missingModel ? undefined : [claude, sol].find((m) => m.provider === provider && m.id === id) },
    ui: { notify: (text) => notifications.push(text), setStatus: (name, text) => statuses.set(name, text) },
  };
  const pi = {
    on: (name, fn) => handlers.set(name, fn), events,
    registerFlag: (name, config) => flags.set(name, config.default),
    getFlag: (name) => name === "claude-account-isolation" ? options.isolation !== false : flags.get(name),
    registerCommand: (name, command) => commands.set(name, command),
    getSettings: () => ({ defaultProvider: claude.provider, defaultModel: claude.id, defaultThinkingLevel: "xhigh" }),
    getThinkingLevel: () => level, setThinkingLevel: (value) => { level = value; },
    appendEntry: (customType, data) => journal.push({ type: "custom", customType, data: structuredClone(data) }),
    exec: async (_command, args) => {
      executions.push(args);
      await options.onIdentify?.();
      const isPersonal = args[0] === `CLAUDE_CONFIG_DIR=${personal}`;
      const loggedIn = !isPersonal || options.personalLogin !== false;
      return { code: loggedIn ? 0 : 1, stdout: JSON.stringify({
        loggedIn, authMethod: isPersonal && options.apiLogin ? "api_key" : "claude.ai",
        email: isPersonal ? options.wrongEmail ? "other@example.test" : config.pessoal.expectedEmail : config.trabalho.expectedEmail,
        subscriptionType: isPersonal ? "pro" : "team", apiProvider: "firstParty",
      }) };
    },
    setModel: async (next) => {
      if (options.rejectModel) return false;
      const previousModel = model;
      model = next;
      switches.push({ ...next, directory: process.env.CLAUDE_CONFIG_DIR });
      if (previousModel.provider !== next.provider || previousModel.id !== next.id) {
        await handlers.get("model_select")?.({ model: next, previousModel, source: "set" }, ctx);
      }
      return true;
    },
  };
  usageFallback(pi);
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, personal, config, writeConfig, handlers, commands, pi, ctx, journal, switches, notifications, executions, statuses,
    start: () => handlers.get("session_start")({}, ctx),
    run: (errorMessage = quota, outcome = "error") => handlers.get("agent_before_settle")({ outcome, context: {
      contextEntries: [{ sourceEntry: { id: "failed-entry" }, messages: [{
        role: "assistant", provider: model.provider, model: model.id, stopReason: "error", errorMessage,
      }] }],
    } }, ctx),
    tick: () => handlers.get("input")({}, ctx),
    headers: (hours, now) => handlers.get("after_provider_response")({ headers: {
      "anthropic-ratelimit-unified-5h-utilization": "1", "anthropic-ratelimit-unified-5h-reset": String((now + hours * 3600_000) / 1000),
    } }, ctx),
    manualModel: (next) => pi.setModel(next),
    busy: (value) => { idle = !value; }, queued: (value) => { pending = value; },
  };
}

function clock(t) {
  let now = Date.UTC(2026, 9, 20, 12);
  t.mock.method(Date, "now", () => now);
  return { now: () => now, set: (value) => { now = value; } };
}

test("work -> personal -> Sol, preserving model, thinking and the failed-entry-only edit", async (t) => {
  const h = harness(t);
  assert.deepEqual(await h.run(), { continue: true, entries: [{ type: "context_edit", targetId: "failed-entry", replacement: null }] });
  assert.equal(process.env.CLAUDE_CONFIG_DIR, h.personal);
  assert.equal(h.ctx.model, claude);
  assert.equal(h.pi.getThinkingLevel(), "xhigh");
  assert.equal(last(h), null);
  assert.equal(last(h, "claude-account-rotation").active, "pessoal");
  await h.run();
  assert.equal(h.ctx.model, sol);
  assert.equal(h.switches.length, 2);
  assert.equal((await h.run()), undefined);
  assert.equal(h.switches.length, 2, "Sol exhaustion must not loop back to exhausted accounts");
});

for (const options of [{ personalLogin: false }, { wrongEmail: true }, { apiLogin: true }]) {
  test(`skips an unverified personal subscription: ${JSON.stringify(options)}`, async (t) => {
    const h = harness(t, options);
    assert.equal((await h.run()).continue, true);
    assert.equal(h.ctx.model, sol);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
    assert.match(h.notifications.join("\n"), /pessoal fora da rotação/);
  });
}

for (const name of OVERRIDES) {
  test(`does not rotate accounts when ${name} overrides the subscription`, async (t) => {
    const h = harness(t);
    process.env[name] = "test-override";
    await h.run();
    assert.equal(h.ctx.model, sol);
    assert.equal(h.executions.length, 0);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  });
}

for (const options of [{ isolation: false }, { optIn: false }]) {
  test(`requires explicit opt-in and an account-aware bridge: ${JSON.stringify(options)}`, async (t) => {
    const h = harness(t, options);
    if (options.optIn === false) { delete h.config.rotation; h.writeConfig(); }
    await h.run();
    assert.equal(h.ctx.model, sol);
    assert.equal(h.executions.length, 0);
  });
}

test("invalid or duplicate identities fail closed instead of sharing quota", async (t) => {
  const h = harness(t);
  h.config.pessoal.expectedEmail = h.config.trabalho.expectedEmail;
  h.writeConfig();
  assert.throws(accountConfig, /distintos/);
  await h.run();
  assert.equal(h.ctx.model, sol);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
});

test("a failed model selection rolls the profile back and keeps the original error", async (t) => {
  const h = harness(t, { rejectModel: true });
  assert.equal(await h.run(), undefined);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(h.ctx.model, claude);
});

test("transient and authentication failures never rotate subscriptions", async (t) => {
  const h = harness(t);
  for (const error of ["fetch failed", "401 Unauthorized", "429 requests per minute", "context limit exceeded"]) assert.equal(await h.run(error), undefined);
  assert.equal(h.executions.length, 0);
  assert.equal(h.switches.length, 0);
});

test("each subscription keeps its own reset; return waits for idle and sends no probes", async (t) => {
  const c = clock(t);
  const h = harness(t);
  h.headers(2, c.now());
  await h.run();
  c.set(c.now() + 60_000);
  h.headers(1, c.now());
  await h.run();
  assert.equal(last(h).profile, "pessoal");
  assert.equal(last(h).nextAt, c.now() + 3600_000 + 60_000);
  c.set(last(h).nextAt);
  h.busy(true); await h.tick(); assert.equal(h.ctx.model, sol);
  h.busy(false); h.queued(true); await h.tick(); assert.equal(h.ctx.model, sol);
  h.queued(false); await h.tick(); assert.equal(h.ctx.model, claude);
  assert.equal(last(h).phase, "trying");
  assert.equal(process.env.CLAUDE_CONFIG_DIR, h.personal);
  await h.run("", "completed");
  assert.equal(last(h), null);
  assert.equal(last(h, "claude-account-rotation").blocked.pessoal, undefined);
});

test("returns to work when its reset is first, without preempting personal while it is working", async (t) => {
  const c = clock(t);
  const h = harness(t);
  h.headers(1, c.now()); await h.run();
  c.set(c.now() + 2 * 3600_000);
  await h.tick();
  assert.equal(process.env.CLAUDE_CONFIG_DIR, h.personal);
  h.headers(3, c.now()); await h.run();
  assert.equal(h.ctx.model, claude, "work is already available and should precede Sol");
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
});

test("resume restores the personal profile from the active branch, not the default work login", async (t) => {
  const h = harness(t);
  await h.run();
  delete process.env.CLAUDE_CONFIG_DIR;
  await h.start();
  assert.equal(process.env.CLAUDE_CONFIG_DIR, h.personal);
  assert.equal(h.ctx.model, claude);
});

test("manual model selection cancels the rotation state and automatic return", async (t) => {
  const h = harness(t);
  await h.run();
  await h.manualModel(sol);
  assert.equal(last(h, "claude-account-rotation"), null);
  assert.deepEqual(last(h), { disabled: true });
});

test("manual account switching clears pending automatic restoration", async (t) => {
  const h = harness(t);
  await h.handlers.get("before_agent_start")({}, h.ctx);
  await h.run(); await h.run();
  h.pi.events.emit(ACCOUNT_CHANGED, { source: "manual" });
  assert.equal(last(h, "claude-account-rotation"), null);
  assert.deepEqual(last(h), { disabled: true });
});

test("abort during identity verification never changes a profile or continues", async (t) => {
  const controller = new AbortController();
  const h = harness(t, { signal: controller.signal, onIdentify: () => controller.abort() });
  assert.equal(await h.run(), undefined);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(h.switches.length, 0);
});

test("the fallback marker must sit once between subscriptions", async (t) => {
  const h = harness(t);
  for (const rotation of [["fallback"], ["fallback", "pessoal"], ["trabalho", "fallback"], ["trabalho", "fallback", "fallback", "pessoal"]]) {
    h.config.rotation = rotation;
    h.writeConfig();
    assert.throws(accountConfig, /fallback|inválida/, JSON.stringify(rotation));
  }
  h.config.rotation = middle;
  h.writeConfig();
  assert.deepEqual(accountConfig().rotation.map((profile) => profile.name), ["trabalho"]);
  assert.deepEqual(accountConfig().reserve.map((profile) => profile.name), ["pessoal"]);
});

test("fallback in the middle: work -> Sol -> personal, then back up as each limit resets", async (t) => {
  const c = clock(t);
  const h = harness(t, { rotation: middle });
  h.headers(2, c.now());
  assert.deepEqual(await h.run(), omitted);
  assert.equal(h.ctx.model, sol, "personal waits until Sol is exhausted too");
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(h.executions.some((args) => args[0] === `CLAUDE_CONFIG_DIR=${h.personal}`), false);
  assert.equal(last(h).profile, "trabalho");

  assert.deepEqual(await h.run(codexQuota), omitted);
  assert.equal(h.ctx.model, claude);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, h.personal);
  assert.equal(h.pi.getThinkingLevel(), "xhigh");
  assert.equal(last(h), null);
  const state = last(h, "claude-account-rotation");
  assert.equal(state.active, "pessoal");
  assert.equal(state.blocked.fallback.nextAt, c.now() + 31 * 60_000);
  assert.equal(h.statuses.get("claude-quota-return"), "Claude pessoal (reserva): sai em 31 min");

  c.set(c.now() + 10 * 60_000);
  await h.tick();
  assert.equal(process.env.CLAUDE_CONFIG_DIR, h.personal, "nothing above the reserve has reset yet");
  c.set(state.blocked.fallback.nextAt);
  h.busy(true); await h.tick(); assert.equal(h.ctx.model, claude);
  h.busy(false); await h.tick();
  assert.equal(h.ctx.model, sol, "Sol precedes the personal reserve once it resets");
  assert.equal(last(h).profile, "trabalho");
  assert.equal(last(h).thinking, "xhigh");
  await h.run("", "completed");
  assert.equal(last(h, "claude-account-rotation").blocked.fallback, undefined);

  c.set(last(h).nextAt);
  await h.tick();
  assert.equal(h.ctx.model, claude);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(last(h, "claude-account-rotation").active, "trabalho");
});

test("the personal reserve goes straight back to work when work resets before Sol", async (t) => {
  const c = clock(t);
  const h = harness(t, { rotation: middle });
  h.headers(1, c.now());
  await h.run();
  await h.run("You have hit your ChatGPT usage limit (plus plan). Try again in ~180 min.");
  assert.equal(process.env.CLAUDE_CONFIG_DIR, h.personal);
  assert.equal(last(h, "claude-account-rotation").blocked.fallback.nextAt, c.now() + 181 * 60_000);
  c.set(c.now() + 61 * 60_000);
  await h.tick();
  assert.equal(h.ctx.model, claude);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(last(h, "claude-account-rotation").active, "trabalho");
  assert.match(h.notifications.at(-1), /trabalho disponível de novo/);
  await h.run("", "completed");
  assert.equal(last(h, "claude-account-rotation").blocked.trabalho, undefined);
});

test("with work, Sol and personal all exhausted, the error stays and nothing loops", async (t) => {
  const c = clock(t);
  const h = harness(t, { rotation: middle });
  h.headers(2, c.now());
  await h.run();
  await h.run(codexQuota);
  const switches = h.switches.length;
  assert.equal(await h.run(), undefined);
  assert.equal(h.switches.length, switches);
  assert.equal(h.ctx.model, claude);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, h.personal);
  assert.match(h.notifications.at(-1), /nenhuma assinatura da rotação está disponível/);
  assert.ok(last(h, "claude-account-rotation").blocked.pessoal);
});

for (const options of [{ personalLogin: false }, { wrongEmail: true }, { apiLogin: true }]) {
  test(`Sol exhaustion keeps Sol's error when personal is unverified: ${JSON.stringify(options)}`, async (t) => {
    const h = harness(t, { rotation: middle, ...options });
    await h.run();
    assert.equal(await h.run(codexQuota), undefined);
    assert.equal(h.ctx.model, sol);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
    assert.match(h.notifications.join("\n"), /pessoal fora da rotação/);
  });
}

test("Sol errors other than its usage limit never reach the personal reserve", async (t) => {
  const h = harness(t, { rotation: middle });
  await h.run();
  const executions = h.executions.length;
  for (const error of ["fetch failed", "401 Unauthorized", "429 requests per minute", "context limit exceeded"]) assert.equal(await h.run(error), undefined);
  assert.equal(h.ctx.model, sol);
  assert.equal(h.executions.length, executions);
});

test("without the fallback marker, Sol exhaustion keeps the old order", async (t) => {
  const h = harness(t);
  await h.run(); await h.run();
  assert.equal(h.ctx.model, sol);
  assert.equal(await h.run(codexQuota), undefined);
  assert.equal(h.ctx.model, sol);
});

test("resume restores the personal reserve and Sol's block from the branch", async (t) => {
  const h = harness(t, { rotation: middle });
  await h.run();
  await h.run(codexQuota);
  delete process.env.CLAUDE_CONFIG_DIR;
  await h.start();
  assert.equal(process.env.CLAUDE_CONFIG_DIR, h.personal);
  assert.equal(h.ctx.model, claude);
  assert.ok(last(h, "claude-account-rotation").blocked.fallback);
});

test("/claude-return off keeps the session on the personal reserve", async (t) => {
  const c = clock(t);
  const h = harness(t, { rotation: middle });
  h.headers(1, c.now());
  await h.run();
  await h.run(codexQuota);
  await h.commands.get("claude-return").handler("off", h.ctx);
  c.set(c.now() + 2 * 3600_000);
  await h.tick();
  assert.equal(process.env.CLAUDE_CONFIG_DIR, h.personal);
  assert.equal(h.ctx.model, claude);
});

test("the adapter namespaces only bridge calls and fans rewrites out to both accounts", async (t) => {
  const h = harness(t);
  const captured = [], handlers = new Map();
  let provider;
  const api = bridgeAPI({ ...h.pi, on: (name, fn) => handlers.set(name, fn), registerProvider: (_name, config) => { provider = config; } });
  api.registerProvider("claude-bridge", { streamSimple: (_model, _context, options) => captured.push(options.sessionId) });
  const rewritten = [];
  api.on("session_compact", (_event, ctx) => rewritten.push(ctx.sessionManager.getSessionId()));
  provider.streamSimple(claude, {}, { sessionId: "original-session" });
  process.env.CLAUDE_CONFIG_DIR = h.personal;
  provider.streamSimple(claude, {}, { sessionId: "original-session" });
  await handlers.get("session_compact")({}, h.ctx);
  assert.notEqual(captured[0], captured[1]);
  assert.deepEqual(rewritten, captured);
  assert.equal(h.ctx.sessionManager.getSessionId(), "original-session");
  assert.equal(captured.some((id) => id.includes(h.personal) || id.includes("example.test")), false);
  assert.equal(captured[1], accountSessionId("original-session", { name: "pessoal", directory: h.personal }));
});

test("the real Pi loader loads the pinned bridge once through the adapter, offline", async (t) => {
  const h = harness(t);
  const install = join(homedir(), ".pi/agent/install");
  const sdkDir = process.env.PI_SDK_DIR ?? join(install, "releases", readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules/@earendil-works/pi-coding-agent");
  const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(sdkDir, "dist/index.js")).href);
  mkdirSync(join(h.dir, "npm/node_modules"), { recursive: true });
  symlinkSync(join(homedir(), ".pi/agent/npm/node_modules/pi-claude-bridge"), join(h.dir, "npm/node_modules/pi-claude-bridge"));
  const loader = new DefaultResourceLoader({
    cwd: h.dir, agentDir: h.dir, settingsManager: SettingsManager.inMemory({}),
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [resolve("ai/pi/extensions/claude-bridge-accounts.ts")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const extensions = loader.getExtensions().extensions;
  assert.equal(extensions.length, 1);
  assert.equal(loader.getExtensions().runtime.pendingProviderRegistrations.filter((p) => p.name === "claude-bridge").length, 1);
  assert.equal(extensions[0].flags.get("claude-account-isolation").default, true);
  for (const handler of extensions[0].handlers.get("session_shutdown") ?? []) await handler({}, h.ctx);
});
