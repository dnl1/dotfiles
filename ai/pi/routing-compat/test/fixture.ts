import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { createNativeCompactionDetails, NATIVE_COMPACTION_SHIM_SUMMARY } from '../vendor/pi-codex-native/src/compaction/types.ts';

export function syntheticBranch(): SessionEntry[] {
  const model = { provider: 'openai-codex', api: 'openai-codex-responses', model: 'fixture-codex', baseUrl: 'https://chatgpt.com/backend-api' };
  const reasoning = (id: string) => ({ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify({ type: 'reasoning', id, summary: [], encrypted_content: 'fixture-opaque' }) });
  const call = (id: string) => ({ type: 'toolCall', id: `call_${id}|ctc_${id}`, name: 'codemode', arguments: { code: 'return 42;' } });
  const assistant = (id: string) => ({ role: 'assistant', ...model, timestamp: 1, stopReason: 'toolUse', content: [reasoning('rs_' + id), call(id)], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const output = (id: string) => ({ role: 'toolResult', toolCallId: `call_${id}|ctc_${id}`, toolName: 'codemode', content: [{ type: 'text', text: '42' }], isError: false, timestamp: 1 });
  const entry = (id: string, parentId: string | null, message: unknown) => ({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00.000Z', message });
  return [
    entry('kept', null, assistant('kept')),
    entry('kept-output', 'kept', output('kept')),
    { type: 'compaction', id: 'checkpoint', parentId: 'kept-output', timestamp: '2026-01-01T00:01:00.000Z', summary: NATIVE_COMPACTION_SHIM_SUMMARY, firstKeptEntryId: 'kept', tokensBefore: 1000,
      details: createNativeCompactionDetails({ ...model, compactedWindow: [{ role: 'user', content: [{ type: 'input_text', text: 'Synthetic project history.' }] }, { type: 'compaction', encrypted_content: 'fixture-checkpoint' }] }) },
    entry('tail-user', 'checkpoint', { role: 'user', timestamp: 1, content: [{ type: 'text', text: 'Continue the synthetic task.' }] }),
    entry('tail-assistant', 'tail-user', assistant('tail')),
    entry('tail-output', 'tail-assistant', output('tail')),
  ] as unknown as SessionEntry[];
}
