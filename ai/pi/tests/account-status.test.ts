import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import accountStatus from "../extensions/account-status.ts";

const OVERRIDES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

function harness(t: any) {
	const dir = mkdtempSync(join(tmpdir(), "pi-accounts-"));
	const work = join(dir, "work");
	const personal = join(dir, "personal");
	mkdirSync(work);
	mkdirSync(personal);
	const keys = ["PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR", ...OVERRIDES];
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	for (const key of OVERRIDES) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.CLAUDE_CONFIG_DIR = work;
	writeFileSync(join(dir, "claude-accounts.json"), JSON.stringify({
		trabalho: { directory: work, expectedEmail: "work@example.test" },
		pessoal: { directory: personal, expectedEmail: "personal@example.test" },
	}));
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const statuses: string[] = [];
	const notifications: string[] = [];
	const confirmations: string[] = [];
	const executions: any[] = [];
	const operations: string[] = [];
	let approved = true;
	let idle = true;
	let queued = false;
	let personalLoggedIn = true;
	let wrongPersonal = false;
	let reloadFails = false;
	let modelAvailable = true;
	let modelAccepted = true;
	const bridgeModel = { provider: "claude-bridge", id: "claude-opus-5-5" };
	const sessionId = "same-session";
	const messages = [{ role: "user", content: "existing history" }];
	const ctx: any = {
		hasUI: true, mode: "tui", model: { provider: "openai-codex", id: "gpt-6.1-sol" },
		ui: {
			setStatus: (_key: string, value: string) => statuses.push(value),
			notify: (value: string) => notifications.push(value),
			confirm: async (_title: string, body: string) => { confirmations.push(body); return approved; },
		},
		isIdle: () => idle, hasPendingMessages: () => queued,
		modelRegistry: { find: () => modelAvailable ? bridgeModel : undefined },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => messages },
		reload: async () => { operations.push("reload"); if (reloadFails) throw new Error("reload failed"); },
	};
	const pi: any = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getSettings: () => ({ defaultProvider: "claude-bridge", defaultModel: bridgeModel.id }),
		setModel: async (model: any) => { operations.push("setModel"); if (modelAccepted) ctx.model = model; return modelAccepted; },
		exec: async (command: string, args: string[], options: any) => {
			executions.push({ command, args, options });
			assert.equal(command, "env");
			assert.deepEqual(args.slice(args[0] === "-u" ? 2 : 1), ["claude", "auth", "status", "--json"]);
			const isPersonal = args[0] === `CLAUDE_CONFIG_DIR=${personal}`;
			return { code: isPersonal && !personalLoggedIn ? 1 : 0, stdout: JSON.stringify({
				loggedIn: !isPersonal || personalLoggedIn, authMethod: "claude.ai",
				email: isPersonal ? wrongPersonal ? "other@example.test" : "personal@example.test" : "work@example.test",
				subscriptionType: isPersonal ? "pro" : "team",
			}) };
		},
	};
	accountStatus(pi);
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
		for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		dir, work, personal, handlers, commands, statuses, notifications, confirmations, executions, operations, ctx, messages,
		setApproved: (v: boolean) => approved = v, setIdle: (v: boolean) => idle = v,
		setQueued: (v: boolean) => queued = v, setPersonalLogin: (v: boolean) => personalLoggedIn = v,
		setWrongPersonal: (v: boolean) => wrongPersonal = v, setReloadFails: (v: boolean) => reloadFails = v,
		setModelAvailable: (v: boolean) => modelAvailable = v, setModelAccepted: (v: boolean) => modelAccepted = v,
		start: () => handlers.get("session_start")({}, ctx),
		switchTo: (profile: string) => commands.get("conta").handler(profile, ctx),
	};
}

test("OpenAI is not labelled as a Claude subscription", async (t) => {
	const h = harness(t);
	await h.start();
	assert.match(h.statuses.at(-1)!, /OpenAI\/Codex/);
	assert.equal(h.executions.length, 0);
});

test("the bridge footer identifies the work account", async (t) => {
	const h = harness(t);
	h.ctx.model = { provider: "claude-bridge", id: "claude-opus-5-5" };
	await h.start();
	assert.match(h.statuses.at(-1)!, /trabalho.*work@example.test.*Team/);
});

test("the default work login unsets CLAUDE_CONFIG_DIR instead of explicitly setting ~/.claude", async (t) => {
	const h = harness(t);
	writeFileSync(join(h.dir, "claude-accounts.json"), JSON.stringify({ trabalho: { directory: null } }));
	delete process.env.CLAUDE_CONFIG_DIR;
	h.ctx.model = { provider: "claude-bridge", id: "claude-opus-5-5" };
	await h.start();
	assert.deepEqual(h.executions[0].args.slice(0, 2), ["-u", "CLAUDE_CONFIG_DIR"]);
	assert.match(h.statuses.at(-1)!, /trabalho.*work@example.test/);
});

test("returning to the default work profile removes the personal config override", async (t) => {
	const h = harness(t);
	writeFileSync(join(h.dir, "claude-accounts.json"), JSON.stringify({
		trabalho: { directory: null, expectedEmail: "work@example.test" },
		pessoal: { directory: h.personal, expectedEmail: "personal@example.test" },
	}));
	process.env.CLAUDE_CONFIG_DIR = h.personal;
	h.ctx.model = { provider: "claude-bridge", id: "claude-opus-5-5" };
	await h.switchTo("trabalho");
	assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
	assert.deepEqual(h.operations, ["setModel", "reload"]);
});

test("both bridge accounts appear in /contas without changing the login", async (t) => {
	const h = harness(t);
	await h.commands.get("contas").handler("", h.ctx);
	assert.match(h.notifications.at(-1)!, /trabalho.*work@example.test.*Team/);
	assert.match(h.notifications.at(-1)!, /pessoal.*personal@example.test.*Pro/);
	assert.equal(process.env.CLAUDE_CONFIG_DIR, h.work);
	assert.deepEqual(h.operations, []);
});

test("switching selects the bridge and reloads without replacing the session or history", async (t) => {
	const h = harness(t);
	await h.start();
	await h.switchTo("pessoal");
	assert.equal(process.env.CLAUDE_CONFIG_DIR, h.personal);
	assert.deepEqual(h.operations, ["setModel", "reload"]);
	assert.equal(h.ctx.model.provider, "claude-bridge");
	assert.equal(h.ctx.sessionManager.getSessionId(), "same-session");
	assert.deepEqual(h.messages, [{ role: "user", content: "existing history" }]);
	assert.match(h.confirmations[0], /histórico.*personal@example.test/);
});

test("the refreshed runtime shows the personal account", async (t) => {
	const h = harness(t);
	process.env.CLAUDE_CONFIG_DIR = h.personal;
	h.ctx.model = { provider: "claude-bridge", id: "claude-opus-5-5" };
	await h.start();
	assert.match(h.statuses.at(-1)!, /pessoal.*personal@example.test.*Pro/);
});

test("switching back to work keeps the currently selected Claude model", async (t) => {
	const h = harness(t);
	process.env.CLAUDE_CONFIG_DIR = h.personal;
	h.ctx.model = { provider: "claude-bridge", id: "claude-sonnet-5-5" };
	h.ctx.modelRegistry.find = (_provider: string, id: string) => ({ provider: "claude-bridge", id });
	await h.switchTo("trabalho");
	assert.equal(process.env.CLAUDE_CONFIG_DIR, h.work);
	assert.equal(h.ctx.model.id, "claude-sonnet-5-5");
});

test("cancelled confirmation does not change account or model", async (t) => {
	const h = harness(t);
	h.setApproved(false);
	await h.switchTo("pessoal");
	assert.equal(process.env.CLAUDE_CONFIG_DIR, h.work);
	assert.deepEqual(h.operations, []);
});

test("switching while busy or with queued messages is refused", async (t) => {
	const h = harness(t);
	h.setIdle(false);
	await h.switchTo("pessoal");
	h.setIdle(true);
	h.setQueued(true);
	await h.switchTo("pessoal");
	assert.deepEqual(h.operations, []);
	assert.equal(h.executions.length, 0);
});

test("a missing personal login shows the isolated login command", async (t) => {
	const h = harness(t);
	h.setPersonalLogin(false);
	await h.switchTo("pessoal");
	assert.match(h.notifications.at(-1)!, /CLAUDE_CONFIG_DIR=.*claude auth login/);
	assert.equal(process.env.CLAUDE_CONFIG_DIR, h.work);
	assert.deepEqual(h.operations, []);
});

test("a different email than configured blocks the switch", async (t) => {
	const h = harness(t);
	h.setWrongPersonal(true);
	await h.switchTo("pessoal");
	assert.match(h.notifications.at(-1)!, /e-mail/);
	assert.deepEqual(h.operations, []);
});

for (const variable of OVERRIDES) {
	test(`${variable} cannot silently override the selected subscription`, async (t) => {
		const h = harness(t);
		process.env[variable] = "test-value";
		await h.switchTo("pessoal");
		assert.match(h.notifications.at(-1)!, new RegExp(variable));
		assert.equal(process.env.CLAUDE_CONFIG_DIR, h.work);
		assert.deepEqual(h.operations, []);
	});
}

test("an unavailable bridge model does not change the account", async (t) => {
	const h = harness(t);
	h.setModelAvailable(false);
	await h.switchTo("pessoal");
	assert.equal(process.env.CLAUDE_CONFIG_DIR, h.work);
	assert.deepEqual(h.operations, []);
});

test("a rejected model selection restores the previous account", async (t) => {
	const h = harness(t);
	h.setModelAccepted(false);
	await h.switchTo("pessoal");
	assert.equal(process.env.CLAUDE_CONFIG_DIR, h.work);
	assert.deepEqual(h.operations, ["setModel"]);
});

test("failed reload restores the original profile environment", async (t) => {
	const h = harness(t);
	h.setReloadFails(true);
	await assert.rejects(h.switchTo("pessoal"), /recarregar/);
	assert.equal(process.env.CLAUDE_CONFIG_DIR, h.work);
});

test("without a UI the status extension does not run auth commands", async (t) => {
	const h = harness(t);
	h.ctx.hasUI = false;
	await h.start();
	assert.equal(h.executions.length, 0);
	assert.deepEqual(h.statuses, []);
});
