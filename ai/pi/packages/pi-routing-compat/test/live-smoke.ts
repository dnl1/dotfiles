import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession, initTheme } from "@earendil-works/pi-coding-agent";

if (!process.argv.includes("--live")) throw new Error("Use --live to allow a small real Codex inference test.");
const realAgent = join(homedir(), ".pi/agent");
const home = mkdtempSync(join(tmpdir(), "pi-routing-live-"));
const previousHome = process.env.HOME;
const previousUser = process.env.USERPROFILE;
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
const errors: string[] = [];
const marker = `ROUTER_CANARY_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
try {
  initTheme("dark", false);
  process.env.HOME = home;
  delete process.env.USERPROFILE;
  const agentDir = join(home, ".pi/agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auto-model.json"), JSON.stringify({
    enabled: true, pricing: { litellm: { enabled: false } },
    constraints: { providerAllow: ["openai-codex"], modelInclude: ["openai-codex/gpt-6.1-sol"] },
    failover: { maxAttempts: 1, requestTimeoutMs: 120000, firstOutputTimeoutMs: 90000 },
    rules: [{ name: "live-smoke-low-effort", when: { trigger: "user" }, then: { thinking: "low" } }],
  }));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(realAgent, "auth.json"), modelsPath: join(realAgent, "models.json"), allowModelNetwork: false, refreshOnCreate: false,
  });
  const settingsManager = SettingsManager.inMemory({
    packages: [resolve(import.meta.dir, "..")], transport: "sse", cacheWarming: "off",
    compaction: { enabled: false, reserveTokens: 2048, keepRecentTokens: 256 }, retry: { enabled: false },
    defaultThinkingLevel: "low",
  });
  const loader = new DefaultResourceLoader({ cwd: home, agentDir, settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true, systemPrompt: "You are a routing integration test assistant. Follow the user exactly. Do not use tools. Keep responses short." });
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
  const model = modelRuntime.getModel("openai-codex", "gpt-6.1-sol");
  if (!model) throw new Error("Configured Codex model missing from the catalog.");
  const made = await createAgentSession({ cwd: home, agentDir, modelRuntime, model, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(home), noTools: "all", thinkingLevel: "low" });
  session = made.session;
  await session.bindExtensions({ mode: "print", onError: error => errors.push(`${error.event}: ${error.error}`) });
  function assertReply(stage: string, expected: string) {
    const last = session!.messages.findLast(message => message.role === "assistant");
    if (last?.role !== "assistant" || last.stopReason !== "stop") throw new Error(`${stage}: ${last?.role === "assistant" ? last.errorMessage ?? last.stopReason : "no assistant response"}`);
    const output = last.content.filter(block => block.type === "text").map(block => block.text).join("");
    if (!output.includes(expected)) throw new Error(`${stage}: expected reply marker missing`);
    if (errors.length) throw new Error(`${stage}: ${errors.join("; ")}`);
    console.log(JSON.stringify({ stage, ok: true, selectedModel: `${session!.model?.provider}/${session!.model?.id}`,
      dispatchedModel: `${last.provider}/${last.model}`, inputTokens: last.usage.input, outputTokens: last.usage.output }));
  }
  const filler = "This is synthetic test data for a throwaway in-memory session. It contains no project data. ".repeat(45);
  await session.prompt(`Remember this exact test marker for later: ${marker}. Reply only LIVE_ROUTER_OK. Synthetic context follows: ${filler}`);
  assertReply("automatic-first-turn", "LIVE_ROUTER_OK");
  await session.prompt("Reply only LIVE_ROUTER_SECOND_OK. Continue remembering the marker from my first message.");
  assertReply("automatic-second-turn", "LIVE_ROUTER_SECOND_OK");
  const compacted = await session.compact("Preserve the exact ROUTER_CANARY marker from the first user message.");
  if (compacted.summary === "[OpenAI native compaction checkpoint]" || !compacted.summary.includes(marker)) throw new Error("Portable compaction lost the test marker.");
  if ((compacted.details as any)?.strategy !== "openai-responses-compaction-v2") throw new Error("Native compaction did not complete.");
  console.log(JSON.stringify({ stage: "native-and-portable-compaction", ok: true, summaryChars: compacted.summary.length }));
  await session.prompt("Reply only with the exact ROUTER_CANARY marker I gave you in the first message.");
  assertReply("automatic-after-compaction", marker);
  if (session.sessionManager.isPersisted()) throw new Error("Live test unexpectedly persisted its throwaway history.");
  console.log(JSON.stringify({ liveTestPassed: true, extensionErrors: errors.length, activeConversationModified: false }));
} finally {
  session?.dispose();
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUser;
  rmSync(home, { recursive: true, force: true });
}
