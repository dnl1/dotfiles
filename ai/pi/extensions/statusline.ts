// Statusline — port of ~/.claude/statusline-command.sh to a pi footer.
//
//   🤖 model | 💪 thinking | 🧠 ctx% | 💰 $cost | ⏱️ 5h ██░░ N% resets in Xh Ym | 7d ...
//   📁 repo | 🌳 worktree | 🌿 branch +staged ~modified
//
// Plan usage (5h/7d) comes from the anthropic-ratelimit-unified-* headers that
// pi-claude-bridge (and the built-in anthropic provider) pass to after_provider_response.
// Toggle with /statusline to get the default footer back.

import { basename, dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const RATE_LIMIT_PREFIX = "anthropic-ratelimit-unified-";
const REFRESH_MS = 30_000;
const GIT_TIMEOUT_MS = 2_000;

type Theme = ExtensionContext["ui"]["theme"];

type GitInfo = {
	repoName: string;
	worktree?: string;
	branch?: string;
	staged: number;
	modified: number;
};

type Window = { pct: number; resetsAt?: number };

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let git: GitInfo | undefined;
	let rateLimits: { fiveHour?: Window; sevenDay?: Window } = {};
	let requestRender: (() => void) | undefined;

	async function runGit(cwd: string, args: string[]): Promise<string | undefined> {
		const res = await pi.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
		return res.code === 0 ? res.stdout.trim() : undefined;
	}

	async function refreshGit(cwd: string) {
		const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
		if (!top) {
			git = { repoName: basename(cwd), staged: 0, modified: 0 };
			requestRender?.();
			return;
		}
		const [dirs, branch, staged, modified] = await Promise.all([
			runGit(cwd, ["rev-parse", "--absolute-git-dir", "--git-common-dir"]),
			runGit(cwd, ["branch", "--show-current"]).then(
				(b) => b || runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
			),
			runGit(cwd, ["diff", "--cached", "--numstat"]),
			runGit(cwd, ["diff", "--numstat"]),
		]);

		// A linked worktree has its own git dir; the common dir points back at the main repo.
		const [gitDir, commonDir] = (dirs ?? "").split("\n");
		const commonAbs = commonDir ? resolve(top, commonDir) : undefined;
		const isLinked = !!gitDir && !!commonAbs && resolve(gitDir) !== commonAbs;

		git = {
			repoName: isLinked ? basename(dirname(commonAbs!)) : basename(top),
			worktree: isLinked ? basename(top) : undefined,
			branch: branch || undefined,
			staged: countLines(staged),
			modified: countLines(modified),
		};
		requestRender?.();
	}

	function install(ctx: ExtensionContext) {
		if (!enabled) return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => void refreshGit(ctx.cwd));
			// Keeps the "resets in" countdown and the git counters fresh while idle.
			const timer = setInterval(() => void refreshGit(ctx.cwd), REFRESH_MS);
			timer.unref?.();

			return {
				dispose() {
					unsubBranch();
					clearInterval(timer);
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const lines = [
						renderTop(ctx, theme, pi.getThinkingLevel(), rateLimits),
						renderBottom(theme, git, footerData.getGitBranch()),
					];
					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/\s+/g, " ").trim());
					if (statuses.length) lines.push(statuses.join(" "));
					return lines.map((line) => truncateToWidth(line, width, theme.fg("dim", "...")));
				},
			};
		});
		void refreshGit(ctx.cwd);
	}

	pi.on("session_start", async (_event, ctx) => install(ctx));

	pi.on("after_provider_response", async (event) => {
		const headers = lowerKeys(event.headers);
		rateLimits = {
			fiveHour: readWindow(headers, "5h") ?? rateLimits.fiveHour,
			sevenDay: readWindow(headers, "7d") ?? rateLimits.sevenDay,
		};
		requestRender?.();
	});

	for (const event of ["tool_execution_end", "agent_end", "user_bash"] as const) {
		pi.on(event, async (_event, ctx) => void refreshGit(ctx.cwd));
	}
	pi.on("thinking_level_select", async () => requestRender?.());
	pi.on("model_select", async () => requestRender?.());

	pi.registerCommand("statusline", {
		description: "Toggle the Claude-style statusline footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				install(ctx);
			} else {
				ctx.ui.setFooter(undefined);
			}
			ctx.ui.notify(enabled ? "Statusline enabled" : "Default footer restored", "info");
		},
	});
}

function renderTop(
	ctx: ExtensionContext,
	theme: Theme,
	thinkingLevel: string,
	rateLimits: { fiveHour?: Window; sevenDay?: Window },
): string {
	const model = ctx.model?.name || ctx.model?.id || "Unknown Model";
	const percent = ctx.getContextUsage()?.percent;
	const usage = percent == null ? "?" : `${Math.round(percent)}%`;
	const cost = `$${sessionCost(ctx).toFixed(2)}`;

	const rl = [
		rateLimits.fiveHour && formatWindow(theme, "5h", rateLimits.fiveHour, "relative"),
		rateLimits.sevenDay && formatWindow(theme, "7d", rateLimits.sevenDay, "absolute"),
	]
		.filter(Boolean)
		.join(" | ");

	const parts = [`🤖 ${model}`];
	if (ctx.model?.reasoning) parts.push(`💪 ${thinkingLevel}`);
	parts.push(`🧠 ${usage}`, `💰 ${cost}`, `⏱️ ${rl}`);
	return parts.join(" | ");
}

function renderBottom(theme: Theme, git: GitInfo | undefined, watchedBranch: string | null): string {
	const dir = git?.repoName ?? "";
	const worktree = git?.worktree ?? "no worktree";

	const branch = git?.branch ?? watchedBranch ?? undefined;
	let gitStr = "no branch";
	if (branch) {
		gitStr = branch;
		if (git && git.staged > 0) gitStr += ` ${theme.fg("success", `+${git.staged}`)}`;
		if (git && git.modified > 0) gitStr += ` ${theme.fg("warning", `~${git.modified}`)}`;
	}
	return `📁 ${dir} | 🌳 ${worktree} | 🌿 ${gitStr}`;
}

// Same accounting as pi's built-in footer: every usage-bearing entry, including pre-compaction ones.
function sessionCost(ctx: ExtensionContext): number {
	let total = 0;
	for (const entry of ctx.sessionManager.getEntries() as any[]) {
		if (entry.type === "usage") {
			total += entry.usage?.cost?.total ?? 0;
		} else if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
			total += entry.message.usage?.cost?.total ?? 0;
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			total += entry.usage?.cost?.total ?? 0;
		}
	}
	return total;
}

function formatWindow(theme: Theme, label: string, w: Window, mode: "relative" | "absolute"): string {
	const color = w.pct >= 90 ? "error" : w.pct >= 70 ? "warning" : "success";
	const reset = w.resetsAt === undefined ? "?" : mode === "relative" ? relativeReset(w.resetsAt) : absoluteReset(w.resetsAt);
	return theme.fg(color, `${label} ${makeBar(w.pct)} ${w.pct}% resets ${reset}`);
}

function makeBar(pct: number, width = 10): string {
	const filled = Math.max(0, Math.min(width, Math.floor((pct * width) / 100)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function relativeReset(resetsAt: number): string {
	const diff = Math.max(0, resetsAt - Math.floor(Date.now() / 1000));
	const hours = Math.floor(diff / 3600);
	const mins = Math.floor((diff % 3600) / 60);
	if (diff < 60) return "in <1m";
	if (hours === 0) return `in ${mins}m`;
	return `in ${hours}h ${mins}m`;
}

// Matches `date "+%b %-d %-I:%M%p"`, e.g. "Oct 24 3:05PM".
function absoluteReset(resetsAt: number): string {
	const d = new Date(resetsAt * 1000);
	const month = d.toLocaleString("en-US", { month: "short" });
	const hour12 = d.getHours() % 12 || 12;
	const mins = String(d.getMinutes()).padStart(2, "0");
	const ampm = d.getHours() < 12 ? "AM" : "PM";
	return `${month} ${d.getDate()} ${hour12}:${mins}${ampm}`;
}

function readWindow(headers: Record<string, string>, abbreviation: string): Window | undefined {
	const utilization = headers[`${RATE_LIMIT_PREFIX}${abbreviation}-utilization`];
	if (utilization === undefined) return undefined;
	const reset = headers[`${RATE_LIMIT_PREFIX}${abbreviation}-reset`];
	return {
		pct: Math.round(Number(utilization) * 100),
		resetsAt: reset === undefined ? undefined : Number(reset),
	};
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
}

function countLines(output: string | undefined): number {
	return output ? output.split("\n").filter(Boolean).length : 0;
}
