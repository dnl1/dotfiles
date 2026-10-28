import { expect, test } from 'bun:test';
import { buildSessionContext, convertToLlm } from '@earendil-works/pi-coding-agent';
import paging from './fixtures/context-paging/src/index.ts';
import { syntheticBranch } from './fixture.ts';
import { buildRequestBody } from '../vendor/pi-codex-native/src/provider/request-body.ts';
import { filterNativeCompactionContextMessages, rewriteResponsesPayloadWithNativeReplay } from '../vendor/pi-codex-native/src/compaction/payload-rewrite.ts';
import { isNativeCompactionEntry } from '../vendor/pi-codex-native/src/compaction/types.ts';

test('paging must remain disabled while native replay owns a checkpoint', async () => {
  const branch: any[] = syntheticBranch();
  for (let i = 0; i < 20; i++) branch.push({ type: 'message', id: `large-${i}`, parentId: branch.at(-1).id, timestamp: '2026-01-01T00:02:00Z', message: { role: 'user', timestamp: 1, content: [{ type: 'text', text: ('Synthetic history ' + i + '. ').repeat(200) }] } });
  const model: any = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'fixture-codex', baseUrl: 'https://chatgpt.com/backend-api', name: 'fixture', reasoning: true, input: ['text'], contextWindow: 272000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const messages = filterNativeCompactionContextMessages(buildSessionContext(branch, branch.at(-1).id).messages);
  const hooks = new Map<string, any>();
  const ctx: any = { model, hasUI: false, isProjectTrusted: () => false,
    getSystemPrompt: () => 'Synthetic test.', getContextUsage: () => ({ tokens: 20000 }),
    abort: () => { throw Error('Unexpected paging abort'); }, ui: { notify() {} },
    sessionManager: { getBranch: () => branch, buildSessionProjection: () => ({ messages }) } };
  const checkReplay = (input: any[]) => rewriteResponsesPayloadWithNativeReplay({ model, branchEntries: branch, compactionEntry: branch.find(isNativeCompactionEntry), payload: buildRequestBody(model, { messages: convertToLlm(input) } as never) });
  expect(checkReplay(messages).ok).toBe(true);
  paging({ on: (name: string, hook: any) => hooks.set(name, hook), registerCommand() {}, registerTool() {}, getActiveTools: () => [], getAllTools: () => [] } as never,
    { projectTrusted: false, globalSettings: { contextPaging: { enabled: true, tokenBudget: 1800, trimToTokens: 1000 } } });
  const changed = await hooks.get('context')({ messages }, ctx);
  expect(changed.messages.length).toBeLessThan(messages.length);
  expect(checkReplay(changed.messages)).toMatchObject({ ok: false, reason: 'expected-pi-replay-mismatch' });
});
