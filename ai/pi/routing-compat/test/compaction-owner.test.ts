import { expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import routingCompat from "../entry.ts";
import { registerNativeReplay } from "../vendor/pi-codex-native/src/compaction/extension.ts";

function capture() {
  const handlers = new Map<string, any[]>();
  const providers: any[] = [];
  const pi: any = new Proxy({
    events: createEventBus(),
    on(name: string, hook: any) { handlers.set(name, [...handlers.get(name) ?? [], hook]); },
    registerProvider(...args: any[]) { providers.push(args); },
    registerTool() {}, registerCommand() {}, registerVirtualModel() {},
    getAllTools: () => [], getActiveTools: () => [], getThinkingLevel: () => "medium",
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  return { pi, handlers, providers };
}

test("compat preserves providers without registering native checkpoint creation", () => {
  const { pi, handlers, providers } = capture();
  routingCompat(pi);
  expect(providers.some(args => args[0]?.id === "openai-codex" || args[0]?.name === "openai-codex" || args[0] === "openai-codex")).toBe(true);
  // Context-window adjustment and auto-model retain their own compaction hooks.
  // The native creator is absent, so no compaction event is emitted or request made.
  const source = String(handlers.get("session_before_compact"));
  expect(source).not.toContain("handleBeforeCompact");
  expect(source).not.toContain("pi-codex-native/compaction/v1");
});

test("legacy replay registration cannot create new checkpoints", async () => {
  const { pi, handlers } = capture();
  registerNativeReplay(pi);
  expect([...handlers.keys()]).toEqual(["before_provider_request"]);
  const payload = { model: "fixture", input: [] };
  const ctx: any = {
    model: { provider: "openai-codex", api: "openai-codex-responses" },
    sessionManager: { getSessionId: () => "fresh-bili-session", getBranch: () => [] },
  };
  expect(await handlers.get("before_provider_request")![0]({ payload }, ctx)).toBeUndefined();
});
