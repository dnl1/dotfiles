import assert from "node:assert/strict";
import test from "node:test";
import { autoRoute, compactAutoStatus, selectedRoute } from "../lib/model-status.ts";

const status = "Auto ON · claude-bridge/claude-opus-5-5 · balanced · general · claude-bridge/claude-opus-5-5";

test("reads the current auto route and removes both duplicate model labels", () => {
	assert.deepEqual(autoRoute(status), { provider: "claude-bridge", id: "claude-opus-5-5" });
	assert.equal(compactAutoStatus(status), "Auto ON · balanced · general");
	assert.equal(autoRoute("Auto OFF · none · balanced · general · Pi Auto Model"), undefined);
});

test("an auto route status takes precedence over the previous response", () => {
	const ctx: any = { model: { provider: "pi-auto-model", id: "auto" }, sessionManager: { getBranch: () => [
		{ type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol", thinkingLevel: "high" } },
	] } };
	assert.equal(selectedRoute(ctx, status)?.provider, "claude-bridge");
	assert.equal(selectedRoute(ctx)?.provider, "openai-codex");
});

test("a direct selection ignores old auto status", () => {
	const ctx: any = { model: { provider: "openai-codex", id: "gpt-6.1-sol" } };
	assert.deepEqual(selectedRoute(ctx, status), ctx.model);
});

test("an auto session without a physical response waits for routing", () => {
	const ctx: any = { model: { provider: "pi-auto-model", id: "auto" }, sessionManager: { getBranch: () => [] } };
	assert.equal(selectedRoute(ctx), undefined);
});
