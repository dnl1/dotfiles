import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCOUNT_CHANGED, ACCOUNT_NAMES, FALLBACK_LINK, OVERRIDES, accountConfig, activeProfile, identify, restoreDirectory, type Profile, type ProfileName } from "../lib/claude-accounts.ts";

const FALLBACK = "openai-codex/gpt-6.1-sol";
const CLAUDE_PROVIDERS = new Set(["claude-bridge", "anthropic"]);
const ENTRY = "claude-quota-return";
const ROTATION_ENTRY = "claude-account-rotation";
const CHECK_MS = 30_000;
const RETRY_MS = 5 * 60_000;
const RESET_GRACE_MS = 60_000;
const USAGE_LIMIT_PATTERNS = [
  /\bquota[_ ]exceeded\b/i,
  /\busage[_ -]limit[_ -](?:reached|exceeded)\b/i,
  /\busage limit has been reached\b/i,
  /\byou(?:'|’)re out of (?:extra )?usage\b/i,
  /\b(?:you(?:'|’)ve|you have) (?:hit|reached) (?:your |the )?(?:usage )?limit\b/i,
  /\b(?:weekly|monthly|session|5[- ]hour|7[- ]day) (?:usage )?limit (?:reached|exceeded)\b/i,
];
// pi-codex-native reports exhaustion as "Codex usage limit reached" or "You have hit your ChatGPT usage limit".
const FALLBACK_LIMIT_PATTERNS = [...USAGE_LIMIT_PATTERNS, /\bhit your ChatGPT usage limit\b/i];

type Selection = { provider: string; id: string };
type Thinking = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type Watch = {
  target: Selection;
  fallback: Selection;
  thinking: Thinking;
  nextAt: number;
  attempts: number;
  phase: "waiting" | "trying";
  profile?: ProfileName;
};
type Link = ProfileName | typeof FALLBACK_LINK;
type Rotation = {
  model: Selection;
  active: ProfileName;
  blocked: Partial<Record<Link, { nextAt: number; attempts: number }>>;
};
type Window = { utilization?: number; reset?: number; status?: string };

function key(model: Selection | undefined): string | undefined {
  return model && `${model.provider}/${model.id}`;
}

function selection(reference: string): Selection {
  const separator = reference.indexOf("/");
  if (separator < 1 || separator === reference.length - 1) throw new Error("Select the model using provider/model.");
  return { provider: reference.slice(0, separator), id: reference.slice(separator + 1) };
}

function validWatch(data: any): data is Watch {
  return data && CLAUDE_PROVIDERS.has(data.target?.provider) && typeof data.target.id === "string" &&
    typeof data.fallback?.provider === "string" && typeof data.fallback.id === "string" &&
    key(data.target) !== key(data.fallback) && Number.isFinite(data.nextAt) && data.nextAt > 0 &&
    Number.isInteger(data.attempts) && data.attempts >= 0 && data.attempts <= 100 &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(data.thinking) &&
    ["waiting", "trying"].includes(data.phase) &&
    (data.profile === undefined || ACCOUNT_NAMES.includes(data.profile));
}

function validRotation(data: any): data is Rotation {
  return data?.model?.provider === "claude-bridge" && typeof data.model.id === "string" &&
    ACCOUNT_NAMES.includes(data.active) && data.blocked && typeof data.blocked === "object" &&
    Object.entries(data.blocked).every(([name, block]: [string, any]) => (name === FALLBACK_LINK || ACCOUNT_NAMES.includes(name as ProfileName)) &&
      Number.isFinite(block?.nextAt) && block.nextAt > 0 && Number.isInteger(block.attempts) && block.attempts >= 0 && block.attempts <= 100);
}

export default function (pi: ExtensionAPI) {
  let watch: Watch | undefined;
  let rotation: Rotation | undefined;
  let windows: Record<string, Window> = {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let switchingTo: string | undefined;
  let returning = false;
  let generation = 0;
  let closed = false;
  let disabled = false;

  pi.registerFlag("usage-fallback", { type: "string", default: FALLBACK, description: "Fallback model when Claude reaches its quota (provider/model)." });
  pi.registerFlag("wait-claude", { type: "boolean", default: false, description: "Start on the selected model and return to Claude while the session is idle." });

  function save() {
    pi.appendEntry(ENTRY, disabled ? { disabled: true } : watch ?? null);
  }

  function saveRotation() { pi.appendEntry(ROTATION_ENTRY, rotation ?? null); }

  function accounts(): { rotation: Profile[]; reserve: Profile[] } {
    if (pi.getFlag("claude-account-isolation") !== true || OVERRIDES.some((name) => process.env[name])) return { rotation: [], reserve: [] };
    return accountConfig();
  }

  function rotationProfiles() { return accounts().rotation; }

  function hasReserve() {
    try { return accounts().reserve.length > 0; } catch { return false; }
  }

  function blocked(link: Link) { return (rotation?.blocked[link]?.nextAt ?? 0) > Date.now(); }

  function fallbackModel(): Selection | undefined {
    try { return watch?.fallback ?? selection(String(pi.getFlag("usage-fallback") ?? FALLBACK)); } catch { return undefined; }
  }

  function claudeTarget(): Selection {
    const settings = pi.getSettings();
    return selection(CLAUDE_PROVIDERS.has(settings.defaultProvider ?? "") && settings.defaultModel
      ? `${settings.defaultProvider}/${settings.defaultModel}` : "claude-bridge/claude-opus-5-5");
  }

  function nextRelease(): string {
    const times = Object.values(rotation?.blocked ?? {}).map((block) => block!.nextAt).filter((time) => time > Date.now());
    if (!times.length) return "";
    return ` The earliest expected reset is at ${new Date(Math.min(...times)).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}.`;
  }

  // Selects the profile's login and the model together; on failure the previous login stays active.
  async function select(ctx: ExtensionContext, profile: Profile, model: Selection): Promise<boolean> {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      restoreDirectory(profile.directory);
      if (await changeModel(ctx, model)) return true;
    } catch { /* Restore below. */ }
    restoreDirectory(previous);
    return false;
  }

  function returnAccount() {
    return rotationProfiles().filter((profile) => rotation?.blocked[profile.name as ProfileName])
      .map((profile) => ({ profile: profile.name as ProfileName, ...rotation!.blocked[profile.name as ProfileName]! }))
      .sort((a, b) => a.nextAt - b.nextAt)[0];
  }

  async function rotate(ctx: ExtensionContext, target: Selection, thinking: Thinking, error: string, attempts: number) {
    if (target.provider !== "claude-bridge" || ctx.mode !== "tui") return false;
    const { rotation: candidates, reserve } = accounts();
    if (candidates.length + reserve.length < 2) return false;
    const current = activeProfile();
    if (![...candidates, ...reserve].some((profile) => profile.name === current.name)) return false;
    const epoch = generation;
    if (!(await identify(pi, current)).authenticated || ctx.signal?.aborted || epoch !== generation) return false;
    if (!rotation || key(rotation.model) !== key(target)) rotation = { model: target, active: current.name as ProfileName, blocked: {} };
    const previousBlock = rotation.blocked[current.name as ProfileName];
    attempts = Math.min(100, Math.max(attempts, previousBlock ? previousBlock.attempts + 1 : 0));
    rotation.blocked[current.name as ProfileName] = { nextAt: retryAt(error, attempts), attempts };
    saveRotation();
    // Reserve subscriptions only serve while the fallback model is also at its limit.
    for (const profile of blocked(FALLBACK_LINK) ? [...candidates, ...reserve] : candidates) {
      if (profile.name === current.name || blocked(profile.name as ProfileName)) continue;
      const account = await identify(pi, profile);
      if (ctx.signal?.aborted || epoch !== generation || key(ctx.model) !== key(target)) return false;
      if (!account.authenticated) {
        if (ctx.hasUI) ctx.ui.notify(`Claude ${profile.name} excluded from rotation: ${account.error ?? "not logged in"}. Use /contas to check.`, "warning");
        continue;
      }
      if (!(await select(ctx, profile, target))) continue;
      rotation.active = profile.name as ProfileName;
      watch = undefined;
      windows = {};
      pi.setThinkingLevel(thinking);
      saveRotation();
      save();
      render(ctx);
      pi.events?.emit(ACCOUNT_CHANGED, { source: "rotation" });
      if (ctx.hasUI) ctx.ui.notify(`Claude ${current.name} reached its limit. Continuing with subscription ${profile.name} in the same conversation.`, "warning");
      return true;
    }
    return false;
  }

  // The fallback model reached its own limit: the first available subscription, reserve included, continues the request.
  async function useReserve(ctx: ExtensionContext, error: string): Promise<boolean> {
    if (ctx.mode !== "tui") return false;
    const { rotation: candidates, reserve } = accounts();
    if (!reserve.length) return false;
    const target = rotation?.model ?? watch?.target ?? claudeTarget();
    if (target.provider !== "claude-bridge" || !ctx.modelRegistry.find(target.provider, target.id)) return false;
    const fallback = ctx.model!;
    const thinking = watch?.thinking ?? pi.getThinkingLevel();
    const epoch = generation;
    if (!rotation || key(rotation.model) !== key(target)) {
      const last = [...candidates, ...reserve].find((profile) => profile.name === activeProfile().name) ?? candidates[0];
      rotation = { model: target, active: last.name as ProfileName, blocked: {} };
    }
    const previousBlock = rotation.blocked[FALLBACK_LINK];
    const attempts = previousBlock ? Math.min(100, previousBlock.attempts + 1) : 0;
    rotation.blocked[FALLBACK_LINK] = { nextAt: retryAt(error, attempts, fallbackReset(error)), attempts };
    saveRotation();
    for (const profile of [...candidates, ...reserve]) {
      if (blocked(profile.name as ProfileName)) continue;
      const account = await identify(pi, profile);
      if (ctx.signal?.aborted || epoch !== generation || key(ctx.model) !== key(fallback)) return false;
      if (!account.authenticated) {
        if (ctx.hasUI) ctx.ui.notify(`Claude ${profile.name} excluded from rotation: ${account.error ?? "not logged in"}. Use /contas to check.`, "warning");
        continue;
      }
      if (!(await select(ctx, profile, target))) continue;
      rotation.active = profile.name as ProfileName;
      watch = undefined;
      windows = {};
      pi.setThinkingLevel(thinking);
      saveRotation();
      save();
      render(ctx);
      pi.events?.emit(ACCOUNT_CHANGED, { source: "rotation" });
      if (ctx.hasUI) ctx.ui.notify(`${key(fallback)} reached its limit. Continuing with Claude subscription ${profile.name} in the same conversation.`, "warning");
      return true;
    }
    if (ctx.hasUI) ctx.ui.notify(`${key(fallback)} reached its limit and no Claude subscription is available.${nextRelease()}`, "warning");
    return false;
  }

  function reserveActive(ctx: ExtensionContext): boolean {
    try {
      return !!rotation && key(ctx.model) === key(rotation.model) && accounts().reserve.some((profile) => profile.name === rotation!.active);
    } catch {
      return false;
    }
  }

  // Reserve is the last resort: while idle, move back up to the first link whose limit has reset.
  async function maybePromote(ctx: ExtensionContext) {
    const current = rotation;
    if (closed || returning || disabled || watch || !current || !reserveActive(ctx) ||
      !ctx.isIdle() || ctx.hasPendingMessages() || ctx.signal?.aborted) return;
    returning = true;
    const epoch = generation;
    const reserveName = current.active;
    const stale = () => closed || epoch !== generation || rotation !== current || !ctx.isIdle() || ctx.hasPendingMessages();
    try {
      const candidates = rotationProfiles();
      for (const profile of candidates) {
        if (blocked(profile.name as ProfileName)) continue;
        const account = await identify(pi, profile);
        if (stale()) return;
        if (!account.authenticated || !(await select(ctx, profile, current.model))) continue;
        current.active = profile.name as ProfileName;
        windows = {};
        saveRotation();
        pi.events?.emit(ACCOUNT_CHANGED, { source: "rotation" });
        if (ctx.hasUI) ctx.ui.notify(`Claude ${profile.name} is available again. Reserve ${reserveName} is now free.`, "info");
        return;
      }
      const fallback = fallbackModel();
      if (stale() || !fallback || blocked(FALLBACK_LINK) || key(fallback) === key(current.model)) return;
      const thinking = pi.getThinkingLevel();
      if (!(await changeModel(ctx, fallback)) || closed || epoch !== generation) return;
      const account = returnAccount();
      watch = {
        target: current.model, fallback, thinking, phase: "waiting",
        attempts: account?.attempts ?? 0, nextAt: account?.nextAt ?? Date.now(),
        profile: account?.profile ?? candidates[0]?.name as ProfileName | undefined,
      };
      save();
      if (ctx.hasUI) ctx.ui.notify(`${key(fallback)} is available again. Reserve ${reserveName} is now free.`, "info");
    } catch {
      /* Stay on reserve and retry on the next cycle. */
    } finally {
      returning = false;
      if (!closed && epoch === generation) render(ctx);
    }
  }

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const minutes = (time: number) => Math.max(0, Math.ceil((time - Date.now()) / 60_000));
    if (!watch && reserveActive(ctx)) {
      const above = [...rotationProfiles().map((profile) => profile.name as Link), FALLBACK_LINK];
      const wait = minutes(Math.min(...above.map((link) => rotation!.blocked[link]?.nextAt ?? 0)));
      return ctx.ui.setStatus(ENTRY, `Claude ${rotation!.active} (reserve): leave ${wait ? `in ${wait} min` : "when idle"}`);
    }
    const wait = watch ? minutes(watch.nextAt) : 0;
    ctx.ui.setStatus(ENTRY, !watch ? undefined : watch.phase === "trying"
      ? "Claude: waiting for the next request to confirm availability"
      : `Claude: return ${wait ? `in ${wait} min` : "when idle"}`);
  }

  function cancel(ctx: ExtensionContext, disable = false) {
    generation++;
    disabled = disable;
    watch = undefined;
    save();
    render(ctx);
  }

  function claudeReset(error: string): number {
    return Math.max(0, ...Object.entries(windows).filter(([name, window]) =>
      window.status === "rejected" || (window.utilization ?? 0) >= 1 ||
      (name === "5h" && /five_hour|5[- ]hour|session limit/i.test(error)) ||
      (name === "7d" && /seven_day|7[- ]day|weekly/i.test(error)),
    ).map(([, window]) => window.reset ?? 0));
  }

  // Codex: "Resets in ~42m.", "Resets in ~3.5h." or "Try again in ~42 min."
  function fallbackReset(error: string): number {
    const match = /\b(?:resets|try again) in ~(\d+(?:\.\d+)?) ?(m|min|h)\b/i.exec(error);
    return match ? Date.now() + Number(match[1]) * (match[2].toLowerCase() === "h" ? 3600_000 : 60_000) : 0;
  }

  function retryAt(error: string, attempts: number, reset = claudeReset(error)): number {
    const now = Date.now();
    const delay = RETRY_MS * Math.min(6, 2 ** Math.max(0, attempts - 1));
    if (!attempts && reset > now) return reset + RESET_GRACE_MS;
    return Math.max(now + delay, reset + RESET_GRACE_MS);
  }

  async function changeModel(ctx: ExtensionContext, model: Selection): Promise<boolean> {
    const found = ctx.modelRegistry.find(model.provider, model.id);
    if (!found) return false;
    switchingTo = key(model);
    try {
      return await pi.setModel(found);
    } finally {
      switchingTo = undefined;
    }
  }

  async function maybeReturn(ctx: ExtensionContext) {
    const pending = watch;
    if (closed || returning || !pending || pending.phase !== "waiting" || Date.now() < pending.nextAt ||
      !ctx.isIdle() || ctx.hasPendingMessages() || ctx.signal?.aborted) return;
    if (key(ctx.model) !== key(pending.fallback)) return cancel(ctx);
    returning = true;
    const epoch = generation;
    const previousDirectory = process.env.CLAUDE_CONFIG_DIR;
    let changedDirectory = false;
    try {
      if (pending.profile) {
        const profile = rotationProfiles().find((candidate) => candidate.name === pending.profile);
        if (!profile || !(await identify(pi, profile)).authenticated) throw new Error("Subscription unavailable.");
        if (closed || epoch !== generation || watch !== pending || !ctx.isIdle() || ctx.hasPendingMessages()) return;
        restoreDirectory(profile.directory);
        changedDirectory = true;
      }
      if (!(await changeModel(ctx, pending.target))) throw new Error("Claude is unavailable or authentication is missing.");
      if (closed || epoch !== generation || watch !== pending) return;
      pi.setThinkingLevel(pending.thinking);
      if (pending.profile && rotation) {
        rotation.active = pending.profile;
        saveRotation();
        windows = {};
        pi.events?.emit(ACCOUNT_CHANGED, { source: "rotation" });
      }
      watch = { ...pending, phase: "trying", attempts: Math.min(100, pending.attempts + 1) };
      save();
      if (ctx.hasUI) ctx.ui.notify("Returning to Claude in this session. The next real request will confirm whether quota is available.", "info");
    } catch {
      if (changedDirectory) restoreDirectory(previousDirectory);
      if (closed || epoch !== generation || watch !== pending) return;
      watch = { ...pending, nextAt: Date.now() + RETRY_MS };
      save();
      if (ctx.hasUI) ctx.ui.notify("Could not select Claude. Will retry while idle in 5 minutes.", "warning");
    } finally {
      returning = false;
      if (!closed && epoch === generation) render(ctx);
    }
  }

  async function idle(ctx: ExtensionContext) {
    await maybeReturn(ctx);
    await maybePromote(ctx);
  }

  function arm(ctx: ExtensionContext) {
    disabled = false;
    if (!ctx.model || CLAUDE_PROVIDERS.has(ctx.model.provider)) {
      save();
      return;
    }
    const settings = pi.getSettings();
    const target = claudeTarget();
    if (!ctx.modelRegistry.find(target.provider, target.id)) {
      if (ctx.hasUI) ctx.ui.notify("Load the Claude provider before enabling automatic return.", "warning");
      return;
    }
    watch = {
      target, fallback: { provider: ctx.model.provider, id: ctx.model.id },
      thinking: settings.defaultThinkingLevel ?? "xhigh", nextAt: retryAt("", 0), attempts: 0, phase: "waiting",
    };
    save();
    render(ctx);
  }

  async function restore(ctx: ExtensionContext, allowFlag: boolean) {
    generation++;
    watch = undefined;
    windows = {};
    rotation = undefined;
    const saved = ctx.sessionManager.getBranch().findLast((item) => item.type === "custom" && item.customType === ROTATION_ENTRY);
    if (saved?.type === "custom" && validRotation(saved.data)) {
      try {
        const { rotation: candidates, reserve } = accounts();
        const profile = [...candidates, ...reserve].find((candidate) => candidate.name === (saved.data as Rotation).active);
        if (profile) {
          rotation = structuredClone(saved.data);
          if (key(ctx.model) === key(rotation!.model)) {
            restoreDirectory(profile.directory);
            if (!(await identify(pi, profile)).authenticated && ctx.hasUI) ctx.ui.notify(`Subscription ${profile.name} for this session is not logged in. Use /contas.`, "warning");
            pi.events?.emit(ACCOUNT_CHANGED, { source: "restore" });
          }
        }
      } catch {
        if (ctx.hasUI) ctx.ui.notify("Could not restore rotation. Check claude-accounts.json.", "warning");
      }
    }
    const entry = ctx.sessionManager.getBranch().findLast((item) => item.type === "custom" && item.customType === ENTRY);
    disabled = entry?.type === "custom" && (entry.data as any)?.disabled === true;
    if (entry?.type === "custom" && validWatch(entry.data)) {
      const expected = entry.data.phase === "waiting" ? entry.data.fallback : entry.data.target;
      if (key(ctx.model) === key(expected)) watch = entry.data;
    } else if (!entry && allowFlag && pi.getFlag("wait-claude") === true) {
      arm(ctx);
    }
    render(ctx);
  }

  let currentContext: ExtensionContext | undefined;
  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    closed = false;
    if (timer) clearInterval(timer);
    await restore(ctx, true);
    timer = setInterval(() => {
      if (closed) return;
      void idle(ctx).catch(() => {});
      render(ctx);
    }, CHECK_MS);
    timer.unref?.();
    await idle(ctx);
  });
  const unsubscribe = pi.events?.on(ACCOUNT_CHANGED, (event: any) => {
    if (event?.source !== "manual") return;
    rotation = undefined;
    windows = {};
    saveRotation();
    if (currentContext) cancel(currentContext, true);
  });
  pi.on("before_agent_start", (_event, ctx) => { currentContext = ctx; });
  pi.on("session_shutdown", () => {
    unsubscribe?.();
    closed = true;
    generation++;
    if (timer) clearInterval(timer);
    timer = undefined;
  });
  pi.on("session_tree", async (_event, ctx) => { await restore(ctx, false); });
  pi.on("input", async (_event, ctx) => { await idle(ctx); });
  pi.on("model_select", (event, ctx) => {
    if ((watch || rotation) && event.source !== "restore" && key(event.model) !== switchingTo) {
      rotation = undefined;
      windows = {};
      saveRotation();
      cancel(ctx, true);
    }
  });
  pi.on("after_provider_response", (event, ctx) => {
    if (!ctx.model || !CLAUDE_PROVIDERS.has(ctx.model.provider)) return;
    const headers = Object.fromEntries(Object.entries(event.headers).map(([name, value]) => [name.toLowerCase(), value]));
    for (const name of ["5h", "7d"]) {
      const prefix = `anthropic-ratelimit-unified-${name}-`;
      const previous = windows[name] ?? {};
      const utilization = Number(headers[prefix + "utilization"]);
      const reset = Number(headers[prefix + "reset"]);
      windows[name] = {
        utilization: Number.isFinite(utilization) ? utilization : previous.utilization,
        reset: Number.isFinite(reset) && reset > 0 ? reset * 1000 : previous.reset,
        status: headers[prefix + "status"] ?? previous.status,
      };
    }
  });

  // Quota failures settle after Pi's ordinary retries. Only this unfinished
  // response is omitted; completed tools and raw transcript entries stay intact.
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome === "completed" && rotation && key(ctx.model) === key(rotation.model)) {
      delete rotation.blocked[rotation.active];
      saveRotation();
    }
    if (event.outcome === "completed" && rotation?.blocked[FALLBACK_LINK] && key(ctx.model) === key(fallbackModel())) {
      delete rotation.blocked[FALLBACK_LINK];
      saveRotation();
    }
    if (event.outcome === "completed" && watch?.phase === "trying" && key(ctx.model) === key(watch.target)) cancel(ctx);
    if (event.outcome !== "error" || ctx.signal?.aborted) return;
    const entry = event.context.contextEntries.findLast((item) => item.messages.length > 0);
    const message = entry?.messages.at(-1);
    if (!entry || message?.role !== "assistant" || message.stopReason !== "error" ||
      ctx.model?.provider !== message.provider || ctx.model.id !== message.model) return;
    const omitFailure = () => ({
      entries: [{ type: "context_edit" as const, targetId: entry.sourceEntry.id, replacement: null }], continue: true,
    });
    if (!CLAUDE_PROVIDERS.has(message.provider)) {
      if (key(ctx.model) !== key(fallbackModel()) || !FALLBACK_LIMIT_PATTERNS.some((pattern) => pattern.test(message.errorMessage ?? ""))) return;
      try {
        if (await useReserve(ctx, message.errorMessage ?? "")) return omitFailure();
      } catch {
        if (ctx.hasUI) ctx.ui.notify("Subscription rotation is unavailable. Check claude-accounts.json and /contas.", "warning");
      }
      return;
    }
    if (!USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(message.errorMessage ?? ""))) return;

    const prior = watch?.phase === "trying" && key(watch.target) === key(ctx.model) ? watch : undefined;
    const fallback = prior?.fallback ?? selection(String(pi.getFlag("usage-fallback") ?? FALLBACK));
    const target = { provider: message.provider, id: message.model };
    const thinking = prior?.thinking ?? pi.getThinkingLevel();
    const epoch = generation;
    try {
      if (await rotate(ctx, target, thinking, message.errorMessage ?? "", prior?.attempts ?? 0)) return omitFailure();
    } catch {
      if (ctx.hasUI) ctx.ui.notify("Subscription rotation is unavailable. Check claude-accounts.json and /contas.", "warning");
    }
    if (ctx.signal?.aborted || epoch !== generation || key(ctx.model) !== key(target)) return;
    if (blocked(FALLBACK_LINK) && hasReserve()) {
      if (ctx.hasUI) ctx.ui.notify(`Claude and ${key(fallback)} are at their limits, and no subscription in the rotation is available.${nextRelease()}`, "warning");
      return;
    }
    let account: ReturnType<typeof returnAccount> | undefined;
    try { account = rotation && returnAccount(); } catch { /* Fallback remains available with invalid configuration. */ }
    let changed = false;
    try { changed = key(fallback) !== key(target) && await changeModel(ctx, fallback); } catch {}
    if (!changed) {
      if (ctx.hasUI) ctx.ui.notify("Claude reached its quota. The fallback model is unavailable; check its provider and login.", "warning");
      return;
    }
    if (ctx.signal?.aborted) return;
    watch = disabled ? undefined : {
      target, fallback, thinking, attempts: account?.attempts ?? prior?.attempts ?? 0,
      nextAt: account?.nextAt ?? retryAt(message.errorMessage ?? "", prior?.attempts ?? 0), phase: "waiting",
      ...(account ? { profile: account.profile } : {}),
    };
    save();
    render(ctx);
    if (ctx.hasUI) ctx.ui.notify(`Claude reached its quota. Continuing with ${key(fallback)}; automatic return is ${watch ? "enabled" : "disabled"}.`, "warning");
    return omitFailure();
  });

  pi.registerCommand("claude-return", {
    description: "Automatic return to Claude: on, off, or status.",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "off") cancel(ctx, true);
      else if (action === "on") arm(ctx);
      else if (action !== "status") {
        if (ctx.hasUI) ctx.ui.notify("Use /claude-return on, off, or status.", "warning");
        return;
      }
      render(ctx);
      if (ctx.hasUI) ctx.ui.notify(watch
        ? `Return to ${key(watch.target)}: ${watch.phase === "trying" ? "next request" : new Date(watch.nextAt).toLocaleString("en-US")}.`
        : "Automatic return to Claude is disabled for this session.", "info");
    },
  });
}
