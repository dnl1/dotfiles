import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
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

// Reports a stream that ends in an error, with the subscription that served it. Reading
// result() does not consume the events, so Pi and auto routing see the stream unchanged.
function reportFailure(pi: ExtensionAPI, stream: unknown, model: string): void {
  const result = (stream as { result?: () => Promise<any> } | undefined)?.result;
  if (typeof result !== "function") return;
  let profile: string;
  try { profile = activeProfile().name; } catch { return; }
  result.call(stream).then((message) => {
    if (message?.stopReason !== "error") return;
    const report: ClaudeStreamError = { profile, model, error: clean(message.errorMessage) };
    pi.events?.emit(CLAUDE_STREAM_ERROR, report);
  }, () => {});
}

// Only the bridge receives per-account IDs. Pi history, tools, and hooks keep the original ID.
export function bridgeAPI(pi: ExtensionAPI): ExtensionAPI {
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
        const stream = config.streamSimple;
        target.registerProvider(name, {
          ...config,
          streamSimple: (model, context, options) => {
            const result = stream(model, context, {
              ...options,
              sessionId: options?.sessionId ? accountSessionId(options.sessionId, activeProfile()) : undefined,
            });
            reportFailure(target, result, model.id);
            return result;
          },
        });
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
  await bridge.default(bridgeAPI(pi));
  pi.registerFlag("claude-account-isolation", {
    type: "boolean", default: true, description: "Isolates bridge sessions by Claude subscription.",
  });
  answerIsolation(pi);
}
