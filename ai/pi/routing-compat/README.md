# Pi routing and Codex compatibility

The dotfiles bootstrap builds `~/.pi/agent/packages/pi-routing-compat` from the installed `pi-auto-model@0.9.2` and `pi-codex-native@0.3.13` packages. The repository contains the patch, hashes, installer and synthetic tests. It contains no vendored dependency tree, credentials or conversation history.

## Runtime

Pi 1.4.0 or later is required. The bootstrap updates older Pi installs before preparing the package. It installs the pinned npm packages, verifies the ten upstream file hashes, applies `compat.patch`, verifies the patched hashes, then activates the settings layer. A failed build leaves the previous compatibility package in place. A changed build backs it up under `~/.pi/agent/backups/`.

Only the compatibility package registers Codex and automatic routing. The npm originals stay installed with `extensions: []`. Runtime dependencies and Pi peers use relative links created on each machine; no Mac paths are copied to WSL. The upstream licenses remain in the generated package.

The patch preserves target-compatible reasoning and binds each routed request to its actual model and session. Billion-context owns automatic context compression. The compatibility entrypoint registers the Codex provider and automatic routing without registering native checkpoint creation or its additional summary request. The original compaction implementation remains available to synthetic upstream tests, but the entrypoint does not activate it.

Existing encrypted checkpoints retain their replay validation. Billion-context can change the outgoing history, so an old checkpoint may still produce `expected-pi-replay-mismatch`. Preserve that session and start a new one after restarting Pi. Do not disable replay validation or discard the checkpoint to force an old session through. Pi records system prompt updates, including MCP changes, and legacy replay checks those updates in their original positions.

After applying changes, restart Pi. Existing session files are not rewritten or deleted. If a session still fails replay validation, preserve it and start a new session; never bypass the parity check.

## Paging and Ponytail

`@rochecompaan/pi-context-paging@0.3.11` remains installed but its extension and `contextPaging.enabled` are disabled. Billion-context manages compression, so keep paging disabled. A regression test also demonstrates that trimming history after an existing native Codex checkpoint produces `expected-pi-replay-mismatch`.

Ponytail is pinned to `0.1.2`. `ai/pi/ponytail.json` sets its default to `off` on both platforms. Use `/ponytail lite` for an explicit session choice. An explicit `PONYTAIL_DEFAULT_MODE` environment variable still takes precedence.

## Tests

Run the generated package's tests in an isolated HOME without network access or credentials, using Bun 1.3.14, the pinned npm packages and Pi 1.4.0 modules:

```sh
python3 ai/pi/routing-compat/install.py /scratch/agent --host-modules /host/node_modules
bash /scratch/agent/packages/pi-routing-compat/test/run.sh
PI_TEST_NPM=/npm python3 -m unittest discover -s tests -p test_pi_sync.py -v
```

The suite uses synthetic JSON roundtrips, dummy authentication, intercepted SSE responses and an in-memory SDK session. It needs no `PI_SESSION_FILE`, captured IDs or paid inference. It also tests failover boundaries, cross-provider summaries, package rebuilds, preservation of local settings and package filters.

Three upstream test files remain excluded because they require the separate Context Windows or Skills packages. One Rust-binary execution case is filtered out. These dependencies are not installed by this compatibility package.

## Updating

Change the npm pins and regenerate `compat.patch` and `patch-manifest.json` together. Re-run the offline tests against the new versions before changing the filters. `pi update --extensions` alone does not update the patched runtime copy; the next bootstrap rebuilds it from the declared pins.

The private repository is the source of truth. Publish its committed snapshot through `sync-public.sh`; direct edits to the public mirror will be replaced by the next publication. Machine sync skips bootstrap while tracked `ai/` files have local edits.
