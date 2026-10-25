# Pi routing and Codex compatibility

The dotfiles bootstrap builds `~/.pi/agent/packages/pi-routing-compat` from the installed `pi-auto-model@0.9.1` and `pi-codex-native@0.3.13` packages. The repository contains the patch, hashes, installer and synthetic tests. It contains no vendored dependency tree, credentials or conversation history.

## Runtime

Pi 1.4.0 or later is required. The bootstrap updates older Pi installs before preparing the package. It installs the pinned npm packages, verifies the seven upstream file hashes, applies `compat.patch`, verifies the patched hashes, then activates the settings layer. A failed build leaves the previous compatibility package in place. A changed build backs it up under `~/.pi/agent/backups/`.

Only the compatibility package registers Codex and automatic routing. The npm originals stay installed with `extensions: []`. Runtime dependencies and Pi peers use relative links created on each machine; no Mac paths are copied to WSL. The upstream licenses remain in the generated package.

The patch preserves target-compatible reasoning and binds each routed request to its actual model and session. Codex owns native compaction and also produces a readable summary for switching providers. That summary requires an additional model request and consumes tokens. A failed summary cancels compaction instead of discarding context. An encrypted-only checkpoint blocks automatic provider switching until a successful `/compact` produces a readable summary.

After applying changes, restart Pi. Existing session files are not rewritten or deleted. If a session still fails replay validation, preserve it and start a new session; never bypass the parity check.

## Paging and Ponytail

`@rochecompaan/pi-context-paging@0.3.9` remains installed but its extension and `contextPaging.enabled` are disabled. A regression test demonstrates that trimming history after a native Codex checkpoint produces `expected-pi-replay-mismatch`. Do not enable paging with this native replay implementation.

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
