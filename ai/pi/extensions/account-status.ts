import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCOUNT_CHANGED, OVERRIDES, activeProfile, clean, identify as identifyAccount, profiles, restoreDirectory, type Profile, type Account } from "../lib/claude-accounts.ts";

import { AUTO_PROVIDER, latestRoute } from "../lib/model-status.ts";

const STATUS = "00-active-account";
const REFRESH_MS = 60_000;
function label(profile: Profile, account: Account): string {
	if (!account.authenticated) return `${profile.name}: ${account.error ?? "sem login"}`;
	const plan = account.plan ? account.plan[0].toUpperCase() + account.plan.slice(1) : "plano não informado";
	return `${profile.name}: ${account.email || "e-mail não informado"} (${plan})`;
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
			const name = provider === "openai-codex" ? "OpenAI/Codex (sem Claude)" : provider === "anthropic" ? "Anthropic direto (fora do bridge)" : clean(provider) || (ctx.model?.provider === AUTO_PROVIDER ? "Auto: aguardando rota" : "nenhum modelo");
			ctx.ui.setStatus(STATUS, `Conta: ${name}`);
			return;
		}
		try {
			const override = OVERRIDES.filter((name) => process.env[name]);
			if (override.length) return ctx.ui.setStatus(STATUS, `Conta: assinatura não verificada (${override.join(", ")})`);
			const profile = activeProfile();
			const account = await identify(profile, force);
			if (generation === epoch && current === ctx) ctx.ui.setStatus(STATUS, `Conta: ${label(profile, account)} | claude-bridge`);
		} catch {
			ctx.ui.setStatus(STATUS, "Conta: configuração de perfis inválida");
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
		description: "Mostra os dois perfis do Claude Code e o provedor ativo, sem trocar o login.",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			try {
				const lines = await Promise.all(profiles().map(async (profile) => label(profile, await identify(profile, true))));
				ctx.ui.notify([`Ativo: ${ctx.model?.provider ?? "nenhum"}/${ctx.model?.id ?? "nenhum"}`, ...lines].join("\n"), "info");
			} catch {
				ctx.ui.notify("Configuração inválida em claude-accounts.json.", "error");
			}
		},
	});

	pi.registerCommand("conta", {
		description: "Troca o claude-bridge na mesma sessão: /conta trabalho ou /conta pessoal.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") return;
			const notify = (message: string) => { switching = false; ctx.ui.notify(message, "warning"); };
			if (switching) return ctx.ui.notify("Uma troca de conta já está em andamento.", "warning");
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return notify("Espere o pedido atual terminar e esvazie a fila antes de trocar de conta.");
			const override = OVERRIDES.filter((name) => process.env[name]);
			if (override.length) return notify(`Estas variáveis podem substituir o login: ${override.join(", ")}. Remova-as antes de trocar de conta.`);
			let profile: Profile | undefined;
			try { profile = profiles().find((candidate) => candidate.name === args.trim()); }
			catch { return notify("Configuração inválida em claude-accounts.json."); }
			if (!profile) return notify("Use /conta trabalho ou /conta pessoal. /contas mostra os logins.");
			switching = true;
			const account = await identify(profile, true);
			if (!account.authenticated) return notify(`${label(profile, account)}. Faça o login em outro terminal:\n${loginCommand(profile)}`);
			const settings = pi.getSettings();
			const modelId = ctx.model?.provider === "claude-bridge" ? ctx.model.id
				: settings.defaultProvider === "claude-bridge" && settings.defaultModel ? settings.defaultModel : "claude-opus-5-5";
			const model = ctx.modelRegistry.find("claude-bridge", modelId);
			if (!model) return notify("Modelo do claude-bridge indisponível. Confira o pacote e use /reload.");
			if (ctx.model?.provider === "claude-bridge" && activeProfile().directory === profile.directory) return notify(`${label(profile, account)} já está ativa.`);
			const confirmed = await ctx.ui.confirm(`Trocar para ${profile.name}?`, `O histórico desta sessão será enviado a ${account.email} no próximo pedido. A troca é manual e não muda o login do outro perfil.`);
			if (!confirmed) { switching = false; return; }
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return notify("A sessão voltou a trabalhar. Tente trocar quando estiver ociosa.");
			const previous = process.env.CLAUDE_CONFIG_DIR;
			try {
				restoreDirectory(profile.directory);
				if (!(await pi.setModel(model))) {
					restoreDirectory(previous);
					return notify("Não foi possível selecionar o claude-bridge. O perfil anterior foi mantido.");
				}
			} catch {
				restoreDirectory(previous);
				return notify("Falha ao selecionar o claude-bridge. O perfil anterior foi mantido.");
			}
			pi.events?.emit(ACCOUNT_CHANGED, { source: "manual" });
			ctx.ui.notify(`${label(profile, account)}. A conversa continua nesta sessão.`, "info");
			// O reload limpa sessões e subprocessos do bridge; o histórico do pi fica intacto.
			try { await ctx.reload(); }
			catch {
				restoreDirectory(previous);
				throw new Error("Falha ao recarregar o bridge; o perfil anterior foi restaurado. Use /reload antes de continuar.");
			}
		},
	});
}
