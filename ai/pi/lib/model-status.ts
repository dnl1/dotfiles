import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const AUTO_PROVIDER = "pi-auto-model";
export const AUTO_STATUS = "pi-auto-model";
export type Route = { provider: string; id: string; thinkingLevel?: string };

export function autoRoute(status: string | undefined): Route | undefined {
	const value = status?.replace(/\u001b\[[0-9;]*m/g, "");
	const target = value?.match(/^Auto ON · ([^\s/]+)\/([^\s·]+) ·/);
	return target ? { provider: target[1], id: target[2] } : undefined;
}

export function latestRoute(ctx: ExtensionContext): Route | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		if (message.provider === AUTO_PROVIDER) continue;
		return { provider: message.provider, id: message.model, thinkingLevel: message.thinkingLevel };
	}
	return undefined;
}

export function selectedRoute(ctx: ExtensionContext, status?: string): Route | undefined {
	if (ctx.model?.provider === AUTO_PROVIDER) return autoRoute(status) ?? latestRoute(ctx);
	return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

export function compactAutoStatus(status: string): string {
	const parts = status.split(" · ");
	return parts.length >= 5 ? [parts[0], parts[2], parts[3]].join(" · ") : status;
}
