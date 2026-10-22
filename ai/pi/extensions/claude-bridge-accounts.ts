import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { activeProfile, directoryKey, profiles, type Profile } from "../lib/claude-accounts.ts";

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

// Só o bridge recebe IDs por conta. Histórico, ferramentas e hooks do Pi mantêm o ID original.
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
        if (name !== "claude-bridge" || !config.streamSimple) throw new Error("Contrato do claude-bridge incompatível com a rotação de contas.");
        const stream = config.streamSimple;
        target.registerProvider(name, {
          ...config,
          streamSimple: (model, context, options) => stream(model, context, {
            ...options,
            sessionId: options?.sessionId ? accountSessionId(options.sessionId, activeProfile()) : undefined,
          }),
        });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default async function (pi: ExtensionAPI) {
  const root = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "npm/node_modules/pi-claude-bridge");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.version !== "0.9.3") throw new Error("A rotação de contas foi validada com pi-claude-bridge@0.9.3. Confira a integração antes de atualizar.");
  const bridge = await import(pathToFileURL(join(realpathSync(root), "src/index.ts")).href);
  await bridge.default(bridgeAPI(pi));
  pi.registerFlag("claude-account-isolation", {
    type: "boolean", default: true, description: "Isola as sessões do bridge por assinatura Claude.",
  });
}
