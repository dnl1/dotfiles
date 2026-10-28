import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, createEventBus, type SessionEntry } from "@earendil-works/pi-coding-agent";
import registerNativeCompaction from "../vendor/pi-codex-native/src/compaction/extension.ts";
import {
  filterNativeCompactionContextMessages,
  rewriteResponsesPayloadWithNativeReplay,
} from "../vendor/pi-codex-native/src/compaction/payload-rewrite.ts";
import { createNativeCompactionDetails, isNativeCompactionEntry, NATIVE_COMPACTION_SHIM_SUMMARY } from "../vendor/pi-codex-native/src/compaction/types.ts";
import { buildRequestBody } from "../vendor/pi-codex-native/src/provider/request-body.ts";
import { compatibilityAction, stripThinkingForRequest } from "../vendor/pi-auto-model/src/compat/guard.ts";
import { handleModelSelect, stateForContext } from "../vendor/pi-auto-model/src/pi/activation.ts";
import { RuntimeStateStore } from "../vendor/pi-auto-model/src/pi/runtime-store.ts";

const model = {
  id: "replay-fixture", name: "Replay fixture", provider: "openai-codex",
  api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272000, maxTokens: 128000,
} as Model<Api>;

const reasoning = (id: string) => ({
  type: "thinking", thinking: "",
  thinkingSignature: JSON.stringify({ type: "reasoning", id, summary: [], encrypted_content: "fixture-opaque" }),
});
const makeUser = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const makeAssistant = (content: unknown[], overrides = {}) => ({
  role: "assistant", provider: model.provider, api: model.api, model: model.id,
  stopReason: "stop", timestamp: 1, content, ...overrides,
});
const messageEntry = (id: string, parentId: string | null, message: unknown) => ({
  type: "message", id, parentId, timestamp: "2026-10-23T00:00:00.000Z", message,
});
const toolCall = (suffix: string) => ({
  type: "toolCall", id: `call_${suffix}|ctc_${suffix}`, name: "codemode",
  arguments: { code: "return 42;" },
});
const toolResult = (suffix: string) => ({
  role: "toolResult", toolCallId: `call_${suffix}|ctc_${suffix}`, toolName: "codemode",
  content: [{ type: "text", text: "42" }], isError: false, timestamp: 1,
});

function fixture() {
  const kept = messageEntry("kept", null, makeAssistant([reasoning("rs_kept"), toolCall("kept")], { stopReason: "toolUse" }));
  const keptResult = messageEntry("kept-result", kept.id, toolResult("kept"));
  const compactedWindow = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "retained request" }] },
    { type: "compaction", encrypted_content: "fixture-checkpoint" },
  ];
  const compaction = {
    type: "compaction", id: "compact", parentId: keptResult.id, timestamp: "2026-10-23T00:01:00.000Z",
    summary: NATIVE_COMPACTION_SHIM_SUMMARY, firstKeptEntryId: kept.id, tokensBefore: 1000,
    details: createNativeCompactionDetails({
      provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl,
      compactedWindow,
    }),
  };
  const tailUser = messageEntry("tail-user", compaction.id, makeUser("continue"));
  const tailAssistant = messageEntry("tail-assistant", tailUser.id, makeAssistant([reasoning("rs_tail"), toolCall("tail")], { stopReason: "toolUse" }));
  const tailResult = messageEntry("tail-result", tailAssistant.id, toolResult("tail"));
  const branch = [kept, keptResult, compaction, tailUser, tailAssistant, tailResult] as unknown as SessionEntry[];
  return { branch, compaction: compaction as unknown as Parameters<typeof rewriteResponsesPayloadWithNativeReplay>[0]["compactionEntry"], compactedWindow };
}

function payloadFor(branch: SessionEntry[], currentModel = model, strip = false) {
  const projected = filterNativeCompactionContextMessages(buildSessionContext(branch, branch.at(-1)?.id ?? null).messages);
  const messages = strip ? stripThinkingForRequest(projected) as AgentMessage[] : projected;
  return buildRequestBody(currentModel, { messages: convertToLlm(messages) } as never);
}

function replay(f = fixture(), payload = payloadFor(f.branch), currentModel = model) {
  return rewriteResponsesPayloadWithNativeReplay({ model: currentModel, payload, branchEntries: f.branch, compactionEntry: f.compaction });
}

function requestHook() {
  const hooks = new Map<string, (...args: any[]) => any>();
  registerNativeCompaction({
    on: (event: string, hook: (...args: any[]) => any) => hooks.set(event, hook),
    events: createEventBus(),
  } as never);
  return hooks.get("before_provider_request")!;
}

function hookContext(branch: SessionEntry[], currentModel = model) {
  return {
    model: currentModel, hasUI: false,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-only" }) },
    sessionManager: { getSessionId: () => "regression-fixture", getBranch: () => branch },
  };
}

describe("replay without pi-auto-model", () => {
  test("restores the opaque checkpoint and keeps every live tail item", () => {
    const f = fixture();
    const result = replay(f);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.rewrittenPayload.input).toEqual([...f.compactedWindow, ...result.segments.postCompactionTail.input]);
    expect(result.segments.postCompactionTail.input.map((item: any) => item.type ?? item.role)).toEqual([
      "user", "reasoning", "custom_tool_call", "custom_tool_call_output",
    ]);
    expect(JSON.stringify(result.rewrittenPayload.input)).not.toContain("rs_kept");
  });

  test("preserves current instructions, leading context and trailing developer prompt", () => {
    const f = fixture();
    const payload = payloadFor(f.branch);
    const leading = { role: "developer", content: "current leading instructions" };
    const trailing = { role: "developer", content: "current trailing instructions" };
    payload.instructions = "current system instructions";
    payload.input = [leading, ...payload.input, trailing];
    const result = replay(f, payload);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.rewrittenPayload.instructions).toBe(payload.instructions);
    expect(result.rewrittenPayload.input[0]).toEqual(leading);
    expect(result.rewrittenPayload.input.at(-1)).toEqual(trailing);
  });

  test("preserves the transient overflow-retry marker", () => {
    const f = fixture();
    const payload = payloadFor(f.branch);
    const marker = {
      role: "user",
      content: [{ type: "input_text", text: "The previous request exceeded the model context window. The conversation was compacted. Continue from the compacted context." }],
    };
    payload.input.push(marker);
    const result = replay(f, payload);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.rewrittenPayload.input.at(-1)).toEqual(marker);
  });

  test("does not mutate the transcript, request, or encrypted checkpoint", () => {
    const f = fixture();
    const payload = payloadFor(f.branch);
    const before = JSON.stringify({ f, payload });
    const result = replay(f, payload);
    expect(result.ok).toBe(true);
    expect(JSON.stringify({ f, payload })).toBe(before);
    if (!result.ok) throw new Error(result.reason);
    (result.rewrittenPayload.input[0] as any).role = "changed";
    expect(f.compactedWindow[0].role).toBe("user");
  });

  test("survives a JSON save/resume roundtrip", () => {
    const f = JSON.parse(JSON.stringify(fixture()));
    expect(replay(f).ok).toBe(true);
  });

  test.each(["error", "aborted"])("ignores a failed assistant attempt (%s)", (stopReason) => {
    const f = fixture();
    f.branch.push(messageEntry("failed", f.branch.at(-1)!.id, makeAssistant([reasoning("rs_failed")], { stopReason })) as unknown as SessionEntry);
    const result = replay(f);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(JSON.stringify(result.rewrittenPayload.input)).not.toContain("rs_failed");
  });

  test("keeps image inputs and Unicode text in the live tail", () => {
    const f = fixture();
    f.branch.push(messageEntry("image", f.branch.at(-1)!.id, {
      role: "user", timestamp: 1,
      content: [{ type: "text", text: "ação, barba e café 💈" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    }) as unknown as SessionEntry);
    const result = replay(f);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const content = (result.rewrittenPayload.input.at(-1) as any).content;
    expect(content[0].text).toBe("ação, barba e café 💈");
    expect(content[1]).toMatchObject({ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" });
  });

  test("does not leak another provider's encrypted reasoning", () => {
    const f = fixture();
    f.branch.push(messageEntry("foreign", f.branch.at(-1)!.id, makeAssistant([{
      type: "thinking", thinking: "", thinkingSignature: "foreign-private-signature",
    }, { type: "text", text: "previous provider reply" }], {
      provider: "anthropic", api: "anthropic-messages", model: "foreign-model",
    })) as unknown as SessionEntry);
    const result = replay(f);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(JSON.stringify(result.rewrittenPayload.input)).not.toContain("foreign-private-signature");
    expect(JSON.stringify(result.rewrittenPayload.input)).toContain("previous provider reply");
  });
});

describe("pi-auto-model incompatibility", () => {
  test("a mixed API history selects blanket thinking removal", () => {
    expect(compatibilityAction(["claude-bridge", model.api], model.api)).toBe("strip-thinking");
    expect(compatibilityAction([model.api], model.api)).toBe("keep");
  });

  test("detects the reasoning and custom-tool offset in a minimal fixture", () => {
    const f = fixture();
    const result = replay(f, payloadFor(f.branch, model, true));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("expected-pi-replay-mismatch");
    expect(result.parity?.mismatches.slice(0, 3)).toEqual([
      "index 1: expected reasoning, got custom_tool_call:codemode",
      "index 2: expected custom_tool_call:codemode, got custom_tool_call_output",
      "index 3: expected custom_tool_call_output, got input:user[1]",
    ]);
  });

  test("manual model selection suspends routing but does not clear mixed API history", () => {
    const store = new RuntimeStateStore();
    const ctx = hookContext([], { ...model, provider: "claude-bridge", api: "claude-bridge" } as Model<Api>);
    const state = stateForContext(store, ctx as never);
    handleModelSelect({ model, source: "set" } as never, state);
    expect(state.activation).toBe("suspended-by-user");
    expect(compatibilityAction(state.sessionRoute.apisUsed ?? [], model.api)).toBe("strip-thinking");
  });
});

describe("provider hook integration", () => {
  test("rewrites an intact request through the real extension hook", async () => {
    const f = fixture();
    const result = await requestHook()({ payload: payloadFor(f.branch) }, hookContext(f.branch));
    expect(result.input.some((item: any) => item.type === "compaction")).toBe(true);
    expect(result.input.filter((item: any) => item.type === "custom_tool_call")).toHaveLength(1);
    expect(result.input.filter((item: any) => item.type === "custom_tool_call_output")).toHaveLength(1);
  });

  test("rejects stripped reasoning through the real extension hook", async () => {
    const f = fixture();
    await expect(requestHook()({ payload: payloadFor(f.branch, model, true) }, hookContext(f.branch)))
      .rejects.toThrow("expected-pi-replay-mismatch");
  });

  test("leaves sessions without a native checkpoint unchanged", async () => {
    expect(await requestHook()({ payload: payloadFor([]) }, hookContext([]))).toBeUndefined();
  });

  test("leaves another provider untouched", async () => {
    const f = fixture();
    expect(await requestHook()({ payload: {} }, hookContext(f.branch, { ...model, provider: "anthropic", api: "anthropic-messages" } as Model<Api>))).toBeUndefined();
  });

  test("refuses replay against a different provider endpoint", async () => {
    const f = fixture();
    await expect(requestHook()({ payload: payloadFor(f.branch) }, hookContext(f.branch, { ...model, baseUrl: "https://different.invalid" })))
      .rejects.toThrow("latest checkpoint with this provider endpoint");
  });
});

describe("fail-closed validation", () => {
  test("rejects a missing compaction boundary", () => {
    const f = fixture();
    f.branch = f.branch.filter(entry => entry.id !== f.compaction.id);
    expect(replay(f)).toMatchObject({ ok: false, reason: "compaction-boundary-not-found" });
  });

  test("rejects a missing kept-entry boundary", () => {
    const f = fixture();
    const payload = payloadFor(f.branch);
    f.compaction.firstKeptEntryId = "missing";
    expect(replay(f, payload)).toMatchObject({ ok: false, reason: "first-kept-entry-not-found" });
  });

  test("rejects an older checkpoint when a newer one exists", () => {
    const f = fixture();
    const payload = payloadFor(f.branch);
    f.branch.push({ ...f.compaction, id: "newer", parentId: f.branch.at(-1)!.id });
    expect(replay(f, payload)).toMatchObject({ ok: false, reason: "unexpected-compaction-after-boundary" });
  });

  test.each(["remove-output", "change-call-id", "change-tool-code", "change-output", "append-unknown-user"])("rejects altered history: %s", (change) => {
    const f = fixture();
    const payload = payloadFor(f.branch);
    if (change === "remove-output") payload.input.pop();
    if (change === "change-call-id") (payload.input.findLast((item: any) => item.type === "custom_tool_call") as any).call_id = "changed";
    if (change === "change-tool-code") (payload.input.findLast((item: any) => item.type === "custom_tool_call") as any).input = "return 99;";
    if (change === "change-output") (payload.input.findLast((item: any) => item.type === "custom_tool_call_output") as any).output = "99";
    if (change === "append-unknown-user") payload.input.push({ role: "user", content: [{ type: "input_text", text: "unknown request" }] });
    expect(replay(f, payload)).toMatchObject({ ok: false, reason: "expected-pi-replay-mismatch" });
  });
});

const sessionPath = process.env.PI_SESSION_FILE;
if (!sessionPath) throw new Error("PI_SESSION_FILE must name the captured local session");
const capturedBytes = readFileSync(sessionPath);
const capturedHash = createHash("sha256").update(capturedBytes).digest("hex");
const entries = capturedBytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
const byId = new Map(entries.map(entry => [entry.id, entry]));

function branchAt(leafId: string): SessionEntry[] {
  const branch = [];
  for (let entry = byId.get(leafId); entry; entry = byId.get(entry.parentId)) branch.push(entry);
  return branch.reverse() as SessionEntry[];
}

const checkpoints = entries.filter(isNativeCompactionEntry);
describe("captured local session", () => {
  for (let i = 0; i < checkpoints.length; i++) {
    const checkpoint = checkpoints[i];
    const next = checkpoints[i + 1];
    const laterLeaf = next ? next.parentId! : entries.findLast(entry => entry.type === "message" && entry.message.role === "user" && entries.indexOf(entry) > entries.indexOf(checkpoint))?.id ?? checkpoint.id;
    const currentModel = { ...model, id: checkpoint.details!.model, api: checkpoint.details!.api, provider: checkpoint.details!.provider, baseUrl: checkpoint.details!.baseUrl } as Model<Api>;
    for (const [label, leafId] of [["immediate", checkpoint.id], ["later-tail", laterLeaf]]) {
      test(`checkpoint ${i + 1}: ${label} restores checkpoint and preserves tool pairing`, () => {
        const branch = branchAt(leafId);
        const payload = payloadFor(branch, currentModel);
        const result = rewriteResponsesPayloadWithNativeReplay({ model: currentModel, payload, branchEntries: branch, compactionEntry: checkpoint });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(`${result.reason}: ${result.parity?.mismatches.slice(0, 3).join("; ")}`);
        const input = result.rewrittenPayload.input as any[];
        expect(input.some(item => item.type === "compaction")).toBe(true);
        const tail = result.segments.postCompactionTail.input as any[];
        const callIds = tail.filter(item => item.type === "custom_tool_call" || item.type === "function_call").map(item => item.call_id);
        const resultIds = tail.filter(item => item.type === "custom_tool_call_output" || item.type === "function_call_output").map(item => item.call_id);
        expect(resultIds).toEqual(callIds);
        expect(input.slice(-tail.length || input.length)).toEqual(tail);
      });
    }
  }

  test("the reported failing turn passes through the provider hook without blanket stripping", async () => {
    const branch = branchAt("39388ffa");
    const checkpoint = branch.findLast(isNativeCompactionEntry)!;
    const currentModel = { ...model, id: checkpoint.details!.model } as Model<Api>;
    const payload = payloadFor(branch, currentModel);
    const result = await requestHook()({ payload }, hookContext(branch, currentModel));
    expect(result.input.some((item: any) => item.type === "compaction")).toBe(true);
    const expected = rewriteResponsesPayloadWithNativeReplay({ model: currentModel, payload, branchEntries: branch, compactionEntry: checkpoint });
    if (!expected.ok) throw new Error(expected.reason);
    expect(result.input).toEqual(expected.rewrittenPayload.input);
  });

  test("blanket stripping reproduces the actual error verbatim", () => {
    const branch = branchAt("39388ffa");
    const checkpoint = branch.findLast(isNativeCompactionEntry)!;
    const currentModel = { ...model, id: checkpoint.details!.model } as Model<Api>;
    const result = rewriteResponsesPayloadWithNativeReplay({
      model: currentModel, payload: payloadFor(branch, currentModel, true), branchEntries: branch, compactionEntry: checkpoint,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.parity?.mismatches.slice(0, 3)).toEqual([
      "index 1: expected reasoning, got custom_tool_call:codemode",
      "index 2: expected custom_tool_call:codemode, got custom_tool_call_output",
      "index 3: expected custom_tool_call_output, got custom_tool_call:codemode",
    ]);
  });

  test("the test run did not alter the captured session", () => {
    expect(createHash("sha256").update(readFileSync(sessionPath)).digest("hex")).toBe(capturedHash);
  });
});
