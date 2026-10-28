import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCOUNT_CHANGED, OVERRIDES, activeProfile, clean, identify as identifyAccount, profiles, restoreDirectory, type Profile, type Account } from "../lib/claude-accounts.ts";

import { AUTO_PROVIDER, latestRoute } from "../lib/model-status.ts";

const STATUS = "00-active-account";
const REFRESH_MS = 60_000;
function label(profile: Profile, account: Account): string {
	if (!account.authenticated) return `${profile.name}: ${account.error ?? "not logged in"}`;
	const plan = account.plan ? account.plan[0].toUpperCase() + account.plan.slice(1) : "plan not reported";
	return `${profile.name}: ${account.email || "email not reported"} (${plan})`;
}

function loginCommand(profile: Profile): string {
	return profile.directory ? `CLAUDE_CONFIG_DIR='${profile.directory.replace(/'/g, "'\\''")}' claude auth login`
		: "env -u CLAUDE_CONFIG_DIR claude auth login";
}

export default function (pi: ExtensionAPI) {
	const cache = new Map<string, { account: Account; at: number }>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let current: ExtensionContext | undefined;
	let generation = 0;
	let switching = false;
	let routedProvider: string | undefined;

	async function identify(profile: Profile, force = false): Promise<Account> {
		const key = `${profile.directory}\n${profile.expectedEmail ?? ""}`;
		const cached = cache.get(key);
		if (!force && cached && Date.now() - cached.at < REFRESH_MS) return cached.account;
		const account = await identifyAccount(pi, profile);
		cache.set(key, { account, at: Date.now() });
		return account;
	}

	async function refresh(ctx: ExtensionContext, force = false) {
		if (!ctx.hasUI) return;
		const epoch = generation;
		const provider = ctx.model?.provider === AUTO_PROVIDER
			? routedProvider ?? latestRoute(ctx)?.provider : ctx.model?.provider;
		if (provider !== "claude-bridge") {
			const name = provider === "openai-codex" ? "OpenAI/Codex (no Claude)" : provider === "anthropic" ? "Direct Anthropic (outside the bridge)" : clean(provider) || (ctx.model?.provider === AUTO_PROVIDER ? "Auto: waiting for a route" : "no model");
			ctx.ui.setStatus(STATUS, `Account: ${name}`);
			return;
		}
		try {
			const override = OVERRIDES.filter((name) => process.env[name]);
			if (override.length) return ctx.ui.setStatus(STATUS, `Account: subscription not verified (${override.join(", ")})`);
			const profile = activeProfile();
			const account = await identify(profile, force);
			if (generation === epoch && current === ctx) ctx.ui.setStatus(STATUS, `Account: ${label(profile, account)} | claude-bridge`);
		} catch {
			ctx.ui.setStatus(STATUS, "Account: invalid profile configuration");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		routedProvider = undefined;
		generation++;
		current = ctx;
		if (timer) clearInterval(timer);
		if (!ctx.hasUI) return;
		timer = setInterval(() => { if (current) void refresh(current); }, REFRESH_MS);
		timer.unref?.();
		await refresh(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		routedProvider = undefined;
		generation++;
		current = ctx;
		await refresh(ctx, true);
	});
	pi.on("provider_stream_event", async (event, ctx) => {
		if (ctx.model?.provider !== AUTO_PROVIDER || event.provider === AUTO_PROVIDER || routedProvider === event.provider) return;
		routedProvider = event.provider;
		generation++;
		current = ctx;
		await refresh(ctx);
	});
	pi.on("message_start", async (event, ctx) => {
		if (ctx.model?.provider !== AUTO_PROVIDER || event.message.role !== "assistant" || event.message.provider === AUTO_PROVIDER || routedProvider === event.message.provider) return;
		routedProvider = event.message.provider;
		generation++;
		current = ctx;
		await refresh(ctx);
	});
	const unsubscribe = pi.events?.on(ACCOUNT_CHANGED, () => {
		generation++;
		cache.clear();
		if (current) void refresh(current, true);
	});
	pi.on("session_shutdown", () => {
		unsubscribe?.();
		generation++;
		current = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
	});

	pi.registerCommand("contas", {
		description: "Shows both Claude Code profiles and the active provider without changing the login.",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			try {
				const lines = await Promise.all(profiles().map(async (profile) => label(profile, await identify(profile, true))));
				ctx.ui.notify([`Active: ${ctx.model?.provider ?? "none"}/${ctx.model?.id ?? "none"}`, ...lines].join("\n"), "info");
			} catch {
				ctx.ui.notify("Invalid configuration in claude-accounts.json.", "error");
			}
		},
	});

	pi.registerCommand("conta", {
		description: "Switches claude-bridge in the same session: /conta trabalho or /conta pessoal.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") return;
			const notify = (message: string) => { switching = false; ctx.ui.notify(message, "warning"); };
			if (switching) return ctx.ui.notify("An account switch is already in progress.", "warning");
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return notify("Wait for the current request to finish and clear the queue before switching accounts.");
			const override = OVERRIDES.filter((name) => process.env[name]);
			if (override.length) return notify(`These variables can override the login: ${override.join(", ")}. Remove them before switching accounts.`);
			let profile: Profile | undefined;
			try { profile = profiles().find((candidate) => candidate.name === args.trim()); }
			catch { return notify("Invalid configuration in claude-accounts.json."); }
			if (!profile) return notify("Use /conta trabalho or /conta pessoal. /contas shows the logins.");
			switching = true;
			const account = await identify(profile, true);
			if (!account.authenticated) return notify(`${label(profile, account)}. Log in from another terminal:\n${loginCommand(profile)}`);
			const settings = pi.getSettings();
			const modelId = ctx.model?.provider === "claude-bridge" ? ctx.model.id
				: settings.defaultProvider === "claude-bridge" && settings.defaultModel ? settings.defaultModel : "claude-opus-5-5";
			const model = ctx.modelRegistry.find("claude-bridge", modelId);
			if (!model) return notify("The claude-bridge model is unavailable. Check the package and use /reload.");
			if (ctx.model?.provider === "claude-bridge" && activeProfile().directory === profile.directory) return notify(`${label(profile, account)} is already active.`);
			const confirmed = await ctx.ui.confirm(`Switch to ${profile.name}?`, `This session's history will be sent to ${account.email} on the next request. The switch is manual and does not change the other profile's login.`);
			if (!confirmed) { switching = false; return; }
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return notify("The session is busy again. Try switching when it is idle.");
			const previous = process.env.CLAUDE_CONFIG_DIR;
			try {
				restoreDirectory(profile.directory);
				if (!(await pi.setModel(model))) {
					restoreDirectory(previous);
					return notify("Could not select claude-bridge. The previous profile was kept.");
				}
			} catch {
				restoreDirectory(previous);
				return notify("Failed to select claude-bridge. The previous profile was kept.");
			}
			pi.events?.emit(ACCOUNT_CHANGED, { source: "manual" });
			ctx.ui.notify(`${label(profile, account)}. The conversation continues in this session.`, "info");
			// Reload clears bridge sessions and subprocesses; Pi history stays intact.
			try { await ctx.reload(); }
			catch {
				restoreDirectory(previous);
				throw new Error("Failed to reload the bridge; the previous profile was restored. Use /reload before continuing.");
			}
		},
	});
}
