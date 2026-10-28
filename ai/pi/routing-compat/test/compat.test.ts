import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { syntheticBranch } from './fixture.ts';
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, createEventBus } from "@earendil-works/pi-coding-agent";
import { stripThinkingForRequest } from "../vendor/pi-auto-model/src/compat/guard.ts";
import { createStreamProxyHandler } from "../vendor/pi-auto-model/src/pi/stream-proxy.ts";
import { CircuitBreaker } from "../vendor/pi-auto-model/src/health/circuit-breaker.ts";
import { analyzeTask } from "../vendor/pi-auto-model/src/task/local-analyzer.ts";
import registerAutoModel from "../vendor/pi-auto-model/extensions/auto-model.ts";
import registerNativeCompaction from "../vendor/pi-codex-native/src/compaction/extension.ts";
import { filterNativeCompactionContextMessages } from "../vendor/pi-codex-native/src/compaction/payload-rewrite.ts";
import { isNativeCompactionEntry } from "../vendor/pi-codex-native/src/compaction/types.ts";
import { buildRequestBody } from "../vendor/pi-codex-native/src/provider/request-body.ts";
import { CodexProviderRuntime } from "../vendor/pi-codex-native/src/provider/runtime.ts";
import { DEFAULT_CODEX_NATIVE_SETTINGS } from "../vendor/pi-codex-native/src/contributions/xsettings.ts";
import { zstdDecompressSync } from "node:zlib";
import { withDispatchModel, getDispatchModel } from "../dispatch-context.ts";

const original: any[] = syntheticBranch();
const checkpoint = original.findLast(isNativeCompactionEntry)!;
const codex = {
  id: checkpoint.details.model, name: "Codex fixture", provider: "openai-codex", api: "openai-codex-responses",
  baseUrl: checkpoint.details.baseUrl, reasoning: true, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000,
};
const claude = { ...codex, id: "fixture-claude", provider: "claude-bridge", api: "claude-bridge" };
const auto = { ...codex, id: "auto", provider: "pi-auto-model", api: "pi-messages" };
const initial = filterNativeCompactionContextMessages(buildSessionContext(original, original.at(-1).id).messages);

function capture() {
  const handlers = new Map<string, any[]>();
  const commands = new Map<string, any>();
  const providers = new Map<string, any>();
  const pi: any = {
    on(name: string, hook: any) { handlers.set(name, [...handlers.get(name) ?? [], hook]); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerProvider(name: string, config: any) { providers.set(name, config); },
    setModel: async () => true, setThinkingLevel() {}, appendEntry() {},
    events: createEventBus(), getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "medium",
  };
  return { handlers, commands, providers, pi };
}
function context(model = codex, branch = original) {
  return {
    model, cwd: "/tmp", scopedModels: [], hasUI: false,
    modelRegistry: {
      find: (provider: string, id: string) => provider === codex.provider ? { ...codex, id } : provider === claude.provider ? { ...claude, id } : undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
    },
    sessionManager: { getSessionId: () => "compat-session", getBranch: () => branch },
    ui: { notify() {}, setStatus() {} },
  };
}
function message(model = codex, stopReason = "stop", content: any[] = [{ type: "text", text: "OK" }]) {
  return {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function target(model: any) { return { id: `${model.provider}/${model.id}`, model, authenticated: true }; }
function plan(models = [codex]) {
  return { targets: models.map(target), thinking: "medium", profile: analyzeTask({ prompt: "debug replay" }),
    requestId: "fixture-request", sessionId: "compat-session", estimatedCostUsd: 0, apisUsed: ["claude-bridge", codex.api] };
}
function immediate(model: any, response = message(model)) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason: "stop", message: response } as never);
  stream.end(response as never);
  return stream;
}

describe("target-aware reasoning", () => {
  test("preserves the exact Codex history for the native serializer", () => {
    const result = stripThinkingForRequest(initial, codex);
    expect(result).toEqual(initial);
    expect(result.every((message, i) => message === initial[i])).toBe(true);
  });
  test("keeps target-compatible Claude reasoning and removes foreign thinking", () => {
    const blocks = [{ type: "thinking", thinking: "summary", thinkingSignature: "private" }, { type: "text", text: "reply" }];
    const source = [message(codex, "stop", blocks), message(claude, "stop", blocks)];
    const result: any = stripThinkingForRequest(source, claude);
    expect(result[0].content).toEqual([blocks[1]]);
    expect(result[1]).toBe(source[1]);
    expect(source[0].content).toEqual(blocks);
  });
  test("retains legacy blanket stripping when no target is known", () => {
    const result: any = stripThinkingForRequest([message(codex, "stop", [{ type: "thinking", thinking: "", thinkingSignature: "x" }])]);
    expect(result[0].content).toEqual([]);
  });
});

describe("manual and virtual routing with synthetic history", () => {
  test("manual Claude/Codex switches no longer change the replay history", async () => {
    const h = capture();
    registerAutoModel(h.pi);
    registerNativeCompaction(h.pi);
    for (const model of [claude, codex]) for (const hook of h.handlers.get("model_select") ?? []) await hook({ model, source: "set" }, context(model));
    let messages = initial;
    for (const hook of h.handlers.get("context") ?? []) messages = (await hook({ messages }, context()))?.messages ?? messages;
    expect(messages).toEqual(initial);
    let payload: any = buildRequestBody(codex as never, { messages: convertToLlm(messages) } as never);
    for (const hook of h.handlers.get("before_provider_request") ?? []) payload = await hook({ payload }, context()) ?? payload;
    expect(payload.input.some((item: any) => item.type === "compaction")).toBe(true);
  });

  test.each([codex.id, "fixture-other-codex"])("virtual proxy restores native checkpoint for target %s", async id => {
    const current = { ...codex, id };
    const h = capture(); registerNativeCompaction(h.pi);
    let sent: any;
    const proxy = createStreamProxyHandler({
      getRegistry: () => ({
        getProvider: () => ({ streamSimple: (model: any, ctx: any, options: any) => {
          const stream = createAssistantMessageEventStream();
          void (async () => {
            expect(getDispatchModel("compat-session")?.id).toBe(id);
            let payload: any = buildRequestBody(model, ctx);
            for (const hook of h.handlers.get("before_provider_request") ?? []) payload = await hook({ payload }, context(auto)) ?? payload;
            sent = payload;
            const response = message(current); stream.push({ type: "done", reason: "stop", message: response } as never); stream.end(response as never);
          })().catch(error => { const response = { ...message(current, "error"), errorMessage: String(error) }; stream.push({ type: "error", reason: "error", error: response } as never); stream.end(response as never); });
          return stream;
        } }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
      }) as never,
      circuits: new CircuitBreaker(), getPendingStream: () => plan([current]) as never,
    });
    const result = await proxy(auto as never, { messages: convertToLlm(initial) } as never, { sessionId: "compat-session" }).result();
    expect(result.stopReason).toBe("stop");
    expect(sent.input.some((item: any) => item.type === "compaction")).toBe(true);
    expect(getDispatchModel("compat-session")).toBeUndefined();
  });

  test("auto-model on selects the virtual control model after manual selection", async () => {
    const h = capture(); let selected: any;
    h.pi.setModel = async (model: any) => { selected = model; return true; };
    registerAutoModel(h.pi);
    const ctx: any = context(codex);
    ctx.modelRegistry.find = (provider: string, id: string) => provider === auto.provider && id === auto.id ? auto : undefined;
    await h.commands.get("auto-model").handler("on", ctx);
    expect(selected).toBe(auto);
  });

  test("portable summary requests remain isolated from native replay", async () => {
    const h = capture(); registerNativeCompaction(h.pi);
    const payload = { model: codex.id, instructions: "You are a context summarization assistant. Summarize.", input: [] };
    expect(await h.handlers.get("before_provider_request")![0]({ payload }, context())).toBeUndefined();
  });

  test("dispatch identity is isolated by session and concurrent requests", async () => {
    const results = await Promise.all([codex, claude].map((model, i) => withDispatchModel("session-" + i, model as never, async () => {
      await Promise.resolve();
      expect(getDispatchModel("session-" + (1 - i))).toBeUndefined();
      return getDispatchModel("session-" + i)?.provider;
    })));
    expect(results).toEqual([codex.provider, claude.provider]);
    expect(getDispatchModel("session-0")).toBeUndefined();
  });
});

describe("actual Codex transport", () => {
  test("automatic dispatch sends the native checkpoint over SSE without a replay mismatch", async () => {
    const h = capture(); registerNativeCompaction(h.pi);
    const runtime = new CodexProviderRuntime({ getSettings: () => ({ ...DEFAULT_CODEX_NATIVE_SETTINGS, cacheDiagnostics: "off" }) });
    runtime.startSession(context(auto) as never);
    const token = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
    const requests: any[] = [];
    const captureFetch: typeof fetch = Object.assign(async (input: any, init: any) => {
      const request = new Request(input, init);
      const bytes = Buffer.from(await request.arrayBuffer());
      requests.push(JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString()));
      const events = [
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "fixture-message", role: "assistant", content: [{ type: "output_text", text: "OK" }] } },
        { type: "response.completed", response: { id: "fixture-response", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      return new Response(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""), { headers: { "content-type": "text/event-stream" } });
    }, { preconnect: fetch.preconnect });
    const proxy = createStreamProxyHandler({
      getRegistry: () => ({ getProvider: () => runtime.provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: `header.${token}.signature` }) }) as never,
      circuits: new CircuitBreaker(), getPendingStream: () => plan() as never,
    });
    try {
      const result = await proxy(auto as never, { messages: convertToLlm(initial) } as never, {
        sessionId: "compat-session", transport: "sse", fetch: captureFetch,
        onPayload: async payload => {
          let next = payload;
          for (const hook of h.handlers.get("before_provider_request") ?? []) next = await hook({ payload: next }, context(auto)) ?? next;
          return next;
        },
      }).result();
      if (result.stopReason !== "stop") throw new Error(result.errorMessage);
      expect(requests).toHaveLength(1);
      expect(requests[0].input.some((item: any) => item.type === "compaction")).toBe(true);
      expect(result.provider).toBe(codex.provider);
    } finally { runtime.shutdown(); }
  });
});

describe("compaction across providers", () => {
  test("auto-model yields native Codex compaction without replacing the checkpoint", async () => {
    const h = capture(); registerAutoModel(h.pi);
    const event = { signal: new AbortController().signal, preparation: { tokensBefore: 100 } };
    expect(await h.handlers.get("session_before_compact")![0](event, context(auto))).toBeUndefined();
    expect(await h.handlers.get("session_before_compact")![0](event, context(codex))).toBeUndefined();
  });

  test("virtual compaction preserves encrypted history and produces a portable summary", async () => {
    const h = capture(); registerNativeCompaction(h.pi);
    const ctx: any = context(auto);
    const token = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
    ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: `header.${token}.signature` });
    ctx.sessionManager.getEntries = () => original;
    ctx.sessionManager.getLeafId = () => original.at(-1).id;
    ctx.getSystemPrompt = () => "test system instructions";
    const requests: any[] = [];
    const summary = "Project decisions and completed changes retained from the encrypted checkpoint.";
    ctx.modelRegistry.streamSimple = (model: any, transcript: any, options: any) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const payload = await options.onPayload(buildRequestBody(model, transcript), model);
        requests.push(payload);
        const response = message(codex, "stop", [{ type: "text", text: summary }]);
        stream.push({ type: "done", reason: "stop", message: response } as never); stream.end(response as never);
      })().catch(error => { const response = { ...message(codex, "error"), errorMessage: String(error) }; stream.push({ type: "error", reason: "error", error: response } as never); stream.end(response as never); });
      return stream;
    };
    ctx.modelRegistry.getRegisteredNativeProvider = () => ({
      streamSimple: (model: any, transcript: any, options: any) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          const payload = await options.onPayload(buildRequestBody(model, transcript), model);
          requests.push(payload);
          options.onOutputItemDone({ type: "compaction", encrypted_content: "new-checkpoint" });
          const response = { ...message(codex), responseId: "fixture-compaction-response" };
          stream.push({ type: "done", reason: "stop", message: response } as never); stream.end(response as never);
        })().catch(error => { const response = { ...message(codex, "error"), errorMessage: String(error) }; stream.push({ type: "error", reason: "error", error: response } as never); stream.end(response as never); });
        return stream;
      },
    });
    const preparation = {
      firstKeptEntryId: original.at(-1).id, messagesToSummarize: initial.slice(0, -1), turnPrefixMessages: [],
      isSplitTurn: false, tokensBefore: 1000, previousSummary: checkpoint.summary,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 },
    };
    const result = await h.handlers.get("session_before_compact")![0]({
      signal: new AbortController().signal, preparation, reason: "manual",
    }, ctx);
    expect(result?.compaction?.summary).toBe(summary);
    expect(result.compaction.details.strategy).toBe("openai-responses-compaction-v2");
    expect(requests).toHaveLength(2);
    expect(requests[0].input.some((item: any) => item.type === "compaction")).toBe(true);
    expect(requests[1].input.at(-1).type).toBe("compaction_trigger");
  });
});

describe("complete automatic route planning", () => {
  test.each([false, true])("planner and proxy retain context with portable summary=%s", async portable => {
    const home = mkdtempSync(join(tmpdir(), "pi-auto-compat-"));
    const savedHome = process.env.HOME;
    const savedUser = process.env.USERPROFILE;
    const branch = structuredClone(original);
    if (portable) branch.findLast(isNativeCompactionEntry).summary = "Portable project history.";
    const h = capture();
    const called: string[] = [];
    const seen: any[] = [];
    const notifications: string[] = [];
    const ctx: any = context(auto, branch);
    ctx.getContextUsage = () => ({ tokens: 2000 });
    ctx.isProjectTrusted = () => false;
    ctx.ui.notify = (text: string) => notifications.push(text);
    ctx.modelRegistry.getAvailable = () => [claude, codex];
    ctx.modelRegistry.hasConfiguredAuth = () => true;
    ctx.modelRegistry.getProvider = (provider: string) => ({ streamSimple: (model: any, transcript: any) => {
      called.push(provider); seen.push(transcript);
      const stream = createAssistantMessageEventStream();
      void (async () => {
        let payload: any = provider === codex.provider ? buildRequestBody(model, transcript) : {};
        for (const hook of h.handlers.get("before_provider_request") ?? []) payload = await hook({ payload }, ctx) ?? payload;
        if (provider === codex.provider) expect(payload.input.some((item: any) => item.type === "compaction")).toBe(true);
        const response = message(model); stream.push({ type: "done", reason: "stop", message: response } as never); stream.end(response as never);
      })().catch(error => { const response = { ...message(model, "error"), errorMessage: String(error) }; stream.push({ type: "error", reason: "error", error: response } as never); stream.end(response as never); });
      return stream;
    } });
    try {
      process.env.HOME = home; delete process.env.USERPROFILE;
      mkdirSync(join(home, ".pi/agent"), { recursive: true });
      writeFileSync(join(home, ".pi/agent/auto-model.json"), JSON.stringify({
        enabled: false, pricing: { litellm: { enabled: false } },
        rules: [{ name: "prefer-claude", when: { trigger: "user" }, then: { prefer: [`${claude.provider}/${claude.id}`] } }],
      }));
      registerAutoModel(h.pi); registerNativeCompaction(h.pi);
      for (const hook of h.handlers.get("session_start") ?? []) await hook({ reason: "resume" }, ctx);
      for (const hook of h.handlers.get("model_select") ?? []) await hook({ model: auto, source: "set" }, ctx);
      for (const hook of h.handlers.get("before_agent_start") ?? []) await hook({
        type: "before_agent_start", prompt: "Summarize the current changes", images: [],
      }, ctx);
      let messages = filterNativeCompactionContextMessages(buildSessionContext(branch, branch.at(-1).id).messages);
      for (const hook of h.handlers.get("context") ?? []) messages = (await hook({ messages }, ctx))?.messages ?? messages;
      const result = await h.providers.get("pi-auto-model").streamSimple(auto, {
        messages: convertToLlm(messages),
      }, { sessionId: "compat-session" }).result();
      if (result.stopReason !== "stop") throw new Error(result.errorMessage + " " + notifications.join("; "));
      expect(called[0]).toBe(portable ? claude.provider : codex.provider);
      if (portable) expect(JSON.stringify(seen[0])).toContain("Portable project history.");
    } finally {
      for (const hook of h.handlers.get("session_shutdown") ?? []) await hook({ reason: "quit" }, ctx);
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUser;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("failover preserves delivery rules", () => {
  test("fails over after rate limit before output", async () => {
    const called: string[] = [];
    const proxy = createStreamProxyHandler({
      getRegistry: () => ({
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
        getProvider: (provider: string) => ({ streamSimple: (model: any) => {
          called.push(provider);
          if (provider === codex.provider) {
            const stream = createAssistantMessageEventStream();
            const error = { ...message(codex, "error"), errorMessage: "rate limited 429" };
            stream.push({ type: "error", reason: "error", error } as never); stream.end(error as never); return stream;
          }
          return immediate(model);
        } }),
      }) as never, circuits: new CircuitBreaker(), getPendingStream: () => plan([codex, claude]) as never,
    });
    expect((await proxy(auto as never, { messages: [] }, { sessionId: "compat-session" }).result()).provider).toBe(claude.provider);
    expect(called).toEqual([codex.provider, claude.provider]);
  });

  test("does not fail over once a tool call has been emitted", async () => {
    const called: string[] = [];
    const proxy = createStreamProxyHandler({
      getRegistry: () => ({
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
        getProvider: (provider: string) => ({ streamSimple: () => {
          called.push(provider); const stream = createAssistantMessageEventStream();
          const partial = message(codex, "error", [{ type: "toolCall", id: "call", name: "write", arguments: {} }]);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial } as never);
          stream.push({ type: "error", reason: "error", error: { ...partial, errorMessage: "503" } } as never); stream.end(partial as never); return stream;
        } }),
      }) as never, circuits: new CircuitBreaker(), getPendingStream: () => plan([codex, claude]) as never,
    });
    const result = await proxy(auto as never, { messages: [] }, { sessionId: "compat-session" }).result();
    expect(result.stopReason).toBe("error"); expect(called).toEqual([codex.provider]);
  });
});
