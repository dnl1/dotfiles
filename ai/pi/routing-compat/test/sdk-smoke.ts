import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession, initTheme } from "@earendil-works/pi-coding-agent";

const home = mkdtempSync(join(tmpdir(), "pi-routing-sdk-"));
const previous = process.env.HOME;
const previousUser = process.env.USERPROFILE;
process.env.HOME = home;
delete process.env.USERPROFILE;
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
try {
  initTheme("dark", false);
  const agentDir = join(home, ".pi/agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auto-model.json"), JSON.stringify({ enabled: true, pricing: { litellm: { enabled: false } }, constraints: { providerAllow: ["fixture-models"] } }));
  const runtime = await ModelRuntime.create({ credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} }, modelsPath: null, refreshOnCreate: false });
  let calls = 0;
  let failQuota = false;
  runtime.registerProvider("fixture-models", {
    apiKey: "fixture", api: "fixture-api", baseUrl: "https://fixture.invalid",
    models: [{ id: "fixture-model", name: "Fixture model", reasoning: false, input: ["text"],
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 128000 }],
    streamSimple: (model, context) => {
      calls++;
      const stream = createAssistantMessageEventStream();
      const response = { role: "assistant", content: [{ type: "text", text: "ROUTER_OK" }], provider: model.provider, api: model.api, model: model.id,
        timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (failQuota) {
        failQuota = false;
        const failure = { ...response, content: [], stopReason: "error", errorMessage: "Claude quota exceeded — rate limit (five_hour): You've hit your org's monthly spend limit" };
        stream.push({ type: "error", reason: "error", error: failure } as never);
        stream.end(failure as never);
      } else {
        stream.push({ type: "done", reason: "stop", message: response } as never);
        stream.end(response as never);
      }
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, packages: [resolve(import.meta.dir, "..")] });
  const loader = new DefaultResourceLoader({ cwd: home, agentDir, settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true });
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
  const model = runtime.getModel("fixture-models", "fixture-model")!;
  const made = await createAgentSession({ cwd: home, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(home), noTools: "all" });
  session = made.session;
  const errors: string[] = [];
  await session.bindExtensions({ mode: "print", onError: error => errors.push(`${error.event}: ${error.error}`) });
  await session.prompt("Say ROUTER_OK.");
  const last = session.messages.findLast(message => message.role === "assistant");
  if (last?.role !== "assistant" || last.model !== "fixture-model" || last.stopReason !== "stop" || calls !== 1) throw new Error(JSON.stringify({ last, calls, errors }));
  if (errors.length) throw new Error(errors.join("; "));
  failQuota = true;
  await session.prompt("Say ROUTER_OK.");
  const failure = session.messages.findLast(message => message.role === "assistant");
  if (failure?.role !== "assistant" || !failure.errorMessage?.includes("Claude quota exceeded") || Number(calls) !== 2) {
    throw new Error(JSON.stringify({ stage: "quota-failure", failure, calls, errors }));
  }
  await session.prompt("Say ROUTER_OK.");
  if (Number(calls) !== 2) throw new Error("A new user prompt bypassed the circuit cooldown.");
  const now = Date.now;
  try {
    Date.now = () => now() + 120_000;
    await session.prompt("Say ROUTER_OK.");
    const recovered = session.messages.findLast(message => message.role === "assistant");
    if (recovered?.role !== "assistant" || recovered.stopReason !== "stop" || Number(calls) !== 3 || errors.length) {
      throw new Error(JSON.stringify({ stage: "quota-recovery", recovered, calls, errors }));
    }
  } finally {
    Date.now = now;
  }
  console.log(JSON.stringify({ sdkLoaded: true, selectedModel: `${session.model?.provider}/${session.model?.id}`, dispatchedModel: `${last.provider}/${last.model}`, providerCalls: calls, quotaRecovery: true, cooldownRespected: true, extensionErrors: errors.length }));
} finally {
  session?.dispose();
  if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
  if (previousUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUser;
  rmSync(home, { recursive: true, force: true });
}
