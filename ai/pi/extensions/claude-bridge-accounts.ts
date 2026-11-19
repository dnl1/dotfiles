import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CLAUDE_STREAM_ERROR, ISOLATION_QUERY, activeProfile, clean, directoryKey, profiles, type ClaudeStreamError, type Profile } from "../lib/claude-accounts.ts";

export function accountSessionId(id: string, profile: Profile): string {
  const account = createHash("sha256").update(directoryKey(profile)).digest("hex").slice(0, 16);
  return `${id}:claude-account:${account}`;
}

function accountContext(ctx: ExtensionContext, profile: Profile): ExtensionContext {
  const manager = new Proxy(ctx.sessionManager, {
    get(target, property) {
      if (property === "getSessionId") return () => accountSessionId(target.getSessionId(), profile);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(ctx, {
    get(target, property) { return property === "sessionManager" ? manager : Reflect.get(target, property, target); },
  });
}

// Hold an empty attempt's start/error until rotation answers. Once any output has
// escaped, never replay it: that includes tool calls and partial responses.
async function forwardAttempt(
  output: AssistantMessageEventStream,
  input: AssistantMessageEventStream,
  retry: (error: string) => Promise<boolean>,
): Promise<boolean> {
  let start: AssistantMessageEvent | undefined;
  let visible = false;
  for await (const event of input) {
    if (event.type === "start") { start = event; continue; }
    if (event.type === "error" && !visible && await retry(event.error.errorMessage ?? "")) return true;
    if (start) { output.push(start); start = undefined; }
    output.push(event);
    visible = true;
  }
  output.end(await input.result());
  return false;
}

async function retryAccount(pi: ExtensionAPI, report: ClaudeStreamError, signal: AbortSignal | undefined, canRetry: boolean): Promise<boolean> {
  if (signal?.aborted) return false;
  let answer = Promise.resolve(false);
  pi.events?.emit(CLAUDE_STREAM_ERROR, { ...report, retry: (pending: Promise<boolean>) => { answer = pending; } });
  return await answer && canRetry && !signal?.aborted && activeProfile().name !== report.profile;
}

type BridgeStream = NonNullable<ProviderConfig["streamSimple"]>;
function accountStream(pi: ExtensionAPI, stream: BridgeStream, createStream: () => AssistantMessageEventStream): BridgeStream {
  return (model, context, options) => {
    const output = createStream();
    void (async () => {
      // ponytail: at most one attempt per configured subscription; no router state is replayed.
      const remaining = profiles().length;
      for (let attempt = 0; attempt < remaining; attempt++) {
        const profile = activeProfile();
        const input = stream(model, context, {
          ...options,
          sessionId: options?.sessionId ? accountSessionId(options.sessionId, profile) : undefined,
        });
        const retry = await forwardAttempt(output, input, (error) => retryAccount(pi, {
          profile: profile.name, model: model.id, error: clean(error),
        }, options?.signal, attempt + 1 < remaining));
        if (!retry) return;
      }
    })().catch((error) => {
      const reason = options?.signal?.aborted ? "aborted" : "error";
      output.push({ type: "error", reason, error: {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        stopReason: reason, errorMessage: clean(String(error)), timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      output.end();
    });
    return output;
  };
}

// Only the bridge receives per-account IDs. Pi history, tools, and hooks keep the original ID.
export function bridgeAPI(pi: ExtensionAPI, createStream: () => AssistantMessageEventStream): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property) {
      if (property === "on") return (name: string, handler: any) => (target.on as (...args: any[]) => () => void)(name, async (event: any, ctx: ExtensionContext) => {
        const allAccounts = ["session_start", "session_compact", "session_tree", "session_shutdown"].includes(name);
        let result: unknown;
        for (const profile of allAccounts ? profiles() : [activeProfile()]) {
          result = await handler(event, accountContext(ctx, profile));
        }
        return result;
      });
      if (property === "registerProvider") return (name: string, config: ProviderConfig) => {
        if (name !== "claude-bridge" || !config.streamSimple) throw new Error("The claude-bridge contract is incompatible with account rotation.");
        target.registerProvider(name, { ...config, streamSimple: accountStream(target, config.streamSimple, createStream) });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Answers usage-fallback's isolation query with this extension's own flag.
export function answerIsolation(pi: ExtensionAPI): void {
  const unsubscribe = pi.events?.on(ISOLATION_QUERY, (query: any) => {
    query?.answer?.(pi.getFlag("claude-account-isolation") === true);
  });
  pi.on("session_shutdown", () => unsubscribe?.());
}

export default async function (pi: ExtensionAPI) {
  const root = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "npm/node_modules/pi-claude-bridge");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.version !== "0.9.3") throw new Error("Account rotation was validated with pi-claude-bridge@0.9.3. Check the integration before upgrading.");
  const bridge = await import(pathToFileURL(join(realpathSync(root), "src/index.ts")).href);
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  await bridge.default(bridgeAPI(pi, createAssistantMessageEventStream));
  pi.registerFlag("claude-account-isolation", {
    type: "boolean", default: true, description: "Isolates bridge sessions by Claude subscription.",
  });
  answerIsolation(pi);
}
