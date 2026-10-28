# Automatic routing and Codex compatibility

This local package contains the `pi-auto-model@0.9.1` router and the `pi-codex-native@0.3.13` provider. The copies live in `vendor/`; the original npm packages remain installed with their extensions disabled to avoid duplicate registrations.

## Fixes

- Preserves the target model's reasoning settings. The Codex serializer still handles Responses history conversion.
- Identifies the actual model for each proxy attempt with session-scoped `AsyncLocalStorage` to validate and restore the correct checkpoint.
- Keeps native compaction with Codex and saves a readable summary for other providers. The summary receives the previous checkpoint in an isolated SSE request.
- Blocks automatic provider switching when an old checkpoint contains only the `[OpenAI native compaction checkpoint]` marker. Run `/compact` to create a readable summary before switching.
- Uses Pi 1.4's context and additional-tool contracts, including extension messages without `prompt`.
- Preserves the fallback rule: after an attempt emits text or a tool call, it cannot be retried on another model.

Each native compaction adds a request for the readable summary, which consumes tokens. If the summary fails, compaction is cancelled and the previous history stays intact.

## Usage

Run `/reload` and `/auto-model on`, or select `pi-auto-model/auto` in `/model`. Pools, weights and rules remain in `~/.pi/agent/auto-model.json`.

For an older session, run `/compact` with Codex selected before enabling automatic mode. New compactions already include both formats.

## Tests

```bash
PI_SESSION_FILE=/path/to/session.jsonl bash test/run.sh
```

The verified suite has 183 tests and an SDK smoke test that loads the package and dispatches through the router. It covers local history, compaction with a readable summary, and Codex transport with a simulated SSE response. It makes no paid inference calls and does not write to the captured session.

Four upstream cases are excluded: two tests depend on `pi-context-windows`, one on `pi-skills`, and one requires compiling the Rust binary. The last is filtered by name; the three files with missing imports are omitted. These dependencies were also missing before this patch.

## Updates and rollback

npm does not update the local copies. When changing either package's version, reapply and test the changes in `compat.patch`.

To roll back, remove `./packages/pi-routing-compat` from `settings.json`, re-enable both npm packages' extensions, and run `/reload`. This also restores the original conflict. A `settings.json.bak-routing-*` backup predates activation.
