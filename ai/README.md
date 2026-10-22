# ai/

AI coding setup for macOS and WSL: pi inside herdr, with Claude Code,
ai-memory, rtk, codebase-memory-mcp, browser tools and shared skills.
`sync-public.sh` publishes this directory except `ai/work/`, the private
work configuration. Logins and runtime state stay on each machine.

How to use the tools day to day: [USAGE.md](USAGE.md). This file covers
installing and wiring them.

```bash
~/.dotfiles/ai/bootstrap.sh            # WSL
~/work/repos/.dotfiles/ai/bootstrap.sh # Mac
```

Prerequisites: `claude`, `curl`, `git`, `python3` (3.11+ for the tests), `jq`,
Node.js (24+ for the Pi tests) and npm on PATH. Install Claude Code from its
[official instructions](https://code.claude.com/docs/en/setup), then authenticate
with `claude auth login`. On macOS, Homebrew is also needed. The root
`setup.sh` supplies the shell tools on WSL/Ubuntu; it does not run this AI
bootstrap automatically. `lazygit` is optional for the Git popup.

Every step checks before it acts. Re-run after adding credentials; MCP entries
with missing prerequisites stay pending. Automatic pulling and re-applying are
opt-in in public clones (see [Auto-sync](#auto-sync)).

## What it sets up

| Piece | Where it is declared | Notes |
|---|---|---|
| Claude Code settings | `claude/settings.base.json` | Deep-merged into `~/.claude/settings.json`; a backup is kept when it changes. Hooks are not part of the layers: the ai-memory installer and the codebase-memory step below register their own. |
| Status line | `claude/statusline-command.sh` | Copied to `~/.claude/`. Needs `jq`. pi's version of it is `pi/extensions/statusline.ts` (see the pi row). |
| Writing rule | `claude/WRITING.md` | Copied to `~/.claude/WRITING.md` and imported (`@WRITING.md`) from the global `~/.claude/CLAUDE.md`: all prose follows the humanizer skill. |
| Global skills | `claude/skills/<name>/` | Each directory replaces `~/.claude/skills/<name>` when they differ, so edit a skill here, not in `~/.claude/skills`. Skills that come from a plugin or from ai-memory are not listed here. |
| Plugin marketplaces | `claude/marketplaces.txt` | `claude plugin marketplace add <owner/repo>` for each third-party marketplace not yet known, before the plugins step. |
| Plugins | `claude/plugins.txt` | `claude plugin install --scope user`; a line starting with `-` uninstalls that plugin. |
| MCP servers | `claude/mcp-servers.json` | `claude mcp add-json --scope user`. A same-name entry defined differently is replaced. The private `work/mcp-servers.json` layer, when present, merges after the base file. `_only_os`, `_requires_env` and `_check` gate new entries; `__HOME__` is substituted. |
| ai-memory | checksum-verified upstream release and installers | Preserves an existing deployment, including the WSL Docker wrapper, instead of starting a second server. Refreshes owned native hooks, session-aware Claude MCP, managed skills and compact routing on every apply. Pi gets its own routing block and native capture/MCP extension. Uses the public `/healthz` probe, which works with bearer auth. Claude's routing block is installed only where built-in memory is off. See [operations](#ai-memory-operations). |
| codebase-memory-mcp | official `install.sh --skip-config` + `claude/hooks/` | `--skip-config`: the installer would add a Bash hook (rtk owns Bash) and three subagents; on a machine installed before that, the bootstrap removes the installer's `hook-augment` hooks, `codebase-memory` skill and agents from Claude Code, and its `extensions/cbmem.ts` and skill from pi. MCP entry from `mcp-servers.json`; hooks `cbm-hook-augment.sh` (SessionStart + Grep/Glob graph context) and `cbm-prune-orphans.sh` (drops indexes of deleted worktrees). Index a repo once: `codebase-memory-mcp cli index_repository --repo-path "$PWD"`. |
| Secret-read guard | `claude/hooks/block-secret-reads.py` | PreToolUse hook that refuses Bash/Read/Edit/Write/Grep calls which would print `.env*` (not `.env.example`), `.sst/`, SSH keys, `~/.config/secrets`, `gh/hosts.yml` or MCP credentials, or dump environment variables. Using a secret without reading it still works (`--env-file`, `DOTENV_CONFIG_PATH`, `source`). Heredoc bodies are not inspected. After any edit run `claude/hooks/test_block_secret_reads.py` (the first five cases are the commands that leaked). |
| rtk | brew / official `install.sh` | Plus `rtk init -g`: a global hook that rewrites Bash commands, and `~/.claude/RTK.md` imported from `~/.claude/CLAUDE.md`. |
| pi | official `install.sh` + `pi/` | `AGENTS.md` and `pi/extensions/*.ts` are symlinked into `~/.pi/agent`, so an edit made from a pi session is an edit to this repo: commit and push it, and the other machine has it after its next pull (sync pauses while it is uncommitted). `settings.base.json`, `claude-bridge.json` and `auto-model.json` are deep-merged into their `~/.pi/agent` files (pi keeps its own state in `settings.json`, and `/auto-model policy` rewrites `auto-model.json`). Packages listed there are installed with `pi install`, and `rtk init -g --agent pi` adds `extensions/rtk.ts`. After the MCP servers step, Claude Code's user-scope servers are copied into `~/.pi/agent/mcp.json` (same format), so pi has the same MCPs as Claude on each machine, except ai-memory: `ai-memory install-hooks --agent pi` writes `extensions/ai-memory-pi.ts`, which captures pi's own events and bridges the memory tools with the pi session id. Claude Code's hooks also fire inside pi's bridge turns, so ai-memory's are prefixed with a `PI_CODING_AGENT` guard, or every pi session would be recorded twice. The humanizer skill is read from the plugin's marketplace clone, not from `plugins/cache`, which keeps superseded versions next to the current one for days and would give pi two skills with the same name. Plugins without a marketplace clone (stark comes from Claude's plugin directory) reach pi as a `git:` package pinned to the commit Claude Code installed, and the MCP server such a plugin brings goes in `pi/mcp.json`, merged after Claude's servers. |
| pi Codex models | `pi/settings.base.json` + `pi/extensions/usage-fallback.ts` | Installs `pi-codex-native@0.3.13` for ChatGPT subscription access to `openai-codex/gpt-6.1-sol` and `openai-codex/gpt-6-astra`. Use `/login` → OpenAI Codex on each machine. When Claude exhausts its usage allowance, the extension continues the same conversation on Sol. The base model is Claude; automatic routing is described below. |
| pi automatic routing | `pi/settings.base.json`, `pi/auto-model.json` | `pi-auto-model@0.9.1`, matching the Mac. It enables automatic routing for new sessions; select a concrete model or use `/auto-model off` to keep that session on it. Your prompts go to Opus 5.5 first; Sol 6.1 and Luna 5.6 complete the `general` pool and take over when it fails. `/auto-model pool gpt-sol` or `/auto-model pool claude` narrows a session, and `/conta` picks the Claude subscription. Devstral never answers your prompts: on the Mac, `llm-mode configure` makes it the preferred model for turns started by extensions. There is no first-output timeout, because Opus at `xhigh` can think for minutes before writing. Runtime budgets, decisions and provider logins are not synced. |
| uv | brew / official installer | Runs the Python MCP servers (`uvx`). |
| ai-jail | brew (this formula trusted, not the tap) / release tarball | `~/.ai-jail` rendered from `ai-jail/<OS>.toml`. |
| MCP credentials | `mcp/` | `~/.config/ai-mcp/` (700) and `secrets.env` (600). Work-specific files come from the optional private overlay. Reached only through `~/.local/bin/ai-mcp-with-secrets`. |
| Playwright | `mcp-servers.json` + `npx -p @playwright/mcp@X playwright install chromium` | Same pinned MCP and Chromium revision on both machines (WSL has no Chrome). |
| Worktree workflow | `shell/devenv.zsh`, `bin/`, `../.tmux.conf` | `nt`/`nti`/`rv`/`wtmerge`/`wtdone`, `git-to-bare-container`, tmux plugins, `.ai-memory.toml` in the global gitignore. The helpers load through `~/.config/ai/env.sh`, so the public `.zshrc` does not change. See [Worktree workflow](#worktree-workflow). |
| herdr, lazygit and gh-dash | `herdr/config.toml`, `lazygit/config.yml`, `gh-dash/config.yml` | Symlinked into `~/.config/herdr/`, lazygit's config directory (`lazygit --print-config-dir`, which is `~/Library/Application Support/lazygit` on macOS), and `${XDG_CONFIG_HOME:-~/.config}/gh-dash/`. Edits through those links land in this repo; herdr preserves its link when saving settings. `Ctrl+B`, `Ctrl+G` opens lazygit; `Ctrl+B`, `Ctrl+P` opens gh-dash scoped to the focused pane's GitHub repository, or to every clone in a folder that groups them. The bootstrap installs herdr from its checksum-verified stable installer when absent, installs/refreshes its Pi, Claude and OpenCode integrations for available agents, and installs gh-dash v4.26.2. Install lazygit separately (`brew install lazygit` on macOS). `gh auth login` is per machine. |
| typescript-language-server | `npm i -g` | Required by the `typescript-lsp` plugin; installed for the active nvm Node. |
| Local coding (Mac) | `bin/llm-mode`, `ollama/llm-mode.json` | Opt-in Devstral Small 2 via a loopback-only Ollama server and a lean pi profile. `on` asks before closing Brave, Discord and Slack; `off` stops its server and reopens the apps. Pi's default model stays unchanged; automatic routing prefers Devstral only for turns started by extensions. The bootstrap installs the helper and provider configuration, but never installs Ollama or downloads models. See [usage](USAGE.md#local-coding-on-the-mac). |
| Auto-sync | `sync.sh` | LaunchAgent `com.dnl1.dotfiles-sync` (macOS) / `dotfiles-sync.timer` (Linux), every 15 min. See [Auto-sync](#auto-sync). |

### pi usage-limit fallback

In the TUI, `usage-fallback.ts` can try the personal Claude subscription before
`openai-codex/gpt-6.1-sol`. Enable this per machine in the private
`~/.pi/agent/claude-accounts.json` file:

```json
{
  "trabalho": { "directory": null, "expectedEmail": "work@example.com" },
  "pessoal": { "directory": "~/.claude-pessoal", "expectedEmail": "personal@example.com" },
  "rotation": ["trabalho", "pessoal"]
}
```

Authenticate the personal profile separately with
`CLAUDE_CONFIG_DIR="$HOME/.claude-pessoal" claude auth login`, then use `/reload`
and `/contas`. Both profiles must have different directories and verified
subscription emails. Missing logins, wrong emails and API authentication are
skipped. Exported Anthropic credentials or gateway variables disable account
rotation. Tokens are neither copied nor committed. A quota failure continues
the same request on the next available account; unrelated errors do not rotate.
An account keeps serving requests until it reaches its own limit. Each account
has its own reset time. When both are exhausted, Sol serves the session until
a Claude account becomes available. Remove `rotation` to keep single-account
fallback. `/claude-return off` disables automatic return, not quota fallback.

Put `"fallback"` between two subscriptions, as in
`["trabalho", "fallback", "pessoal"]`, to hold the ones after it in reserve:
work, then Sol, then personal. The reserve takes over only when Sol reports its
own usage limit; other Sol errors leave the session on Sol. While the reserve
serves, the session moves back to work or Sol as soon as either resets,
preferring work. With all three exhausted, the last error stays. The marker
must appear once, with a subscription on each side.

`claude-bridge-accounts.ts` loads the unmodified `pi-claude-bridge@0.9.3` package.
Its package declaration has `extensions: []` to prevent loading it twice. The
adapter gives the bridge separate session IDs for each profile, including
compaction and tree events; Pi's history and memory hooks retain the original
session ID. The version is pinned because this adapter depends on the bridge's
per-session state. Revalidate it before upgrading. `/conta trabalho` and
`/conta pessoal` still allow manual switching and cancel a pending return.

Without account rotation, a Claude subscription/quota error switches the current
session directly to Sol and continues the interrupted request.
Completed tools and conversation history are kept. The extension records the
original Claude model and thinking level, then returns to it after the latest
blocked 5-hour or weekly reset, plus one minute. It checks the clock every 30
seconds and before user input; it switches only while idle, without queued work.
No probe prompts or usage-endpoint polling are sent. The next real request
confirms availability. Without reset headers it waits five minutes; repeated
quota failures back off for 5, 10, 20, then at most 30 minutes.

The wait survives session resume and reload. A manual model change or
`/claude-return off` disables return for that session; `/claude-return on` enables
it again and `/claude-return status` shows the wait. Reload existing pi sessions
with `/reload`; if already on a fallback from the old extension, also use
`/claude-return on`. Without a Codex login or the model in the catalog, the
original error remains. Network, authentication, context-window errors and
transient per-minute throttles do not trigger fallback. Errors from the fallback
model do not trigger the quota-recovery path.

Pi 1.3 treats quota errors as non-retryable, so a virtual model's `retry` route
alone cannot catch them. The extension uses `agent_before_settle` and an
append-only context edit to omit the failed response from model context while
keeping it in raw history. `pi.setModel` saves the session's model without
changing the global default. Verify the handler and the real Pi agent loop
offline with `node --test tests/pi-*.test.mjs ai/pi/tests/account-status.test.ts`
(Node 24+ and a managed Pi install with the pinned bridge; npm installs can set
`PI_SDK_DIR` to the coding-agent package path). The rotation tests exercise the
real Pi loop and bridge with an offline SDK transport; they send no requests to
Claude.

## ai-memory operations

The setup follows [upstream's installation guide](https://github.com/akitaonrails/ai-memory/blob/main/INSTALL_FOR_AGENTS.md)
and [Docker/native upgrade instructions](https://github.com/akitaonrails/ai-memory/blob/main/docs/install.md#keeping-ai-memory-up-to-date),
audited against v3.1.2. Keep the CLI, native hook client and running server on the
same release: `ai-memory --version` checks the CLI; `ai-memory status` reports
the server's actual version. A Docker image pull alone does not update a running
container. Review and run the recreation command that `ai-memory upgrade`
provides, preserving the existing data volume. On WSL the bootstrap starts the
`ai-memory` container when it exists but is stopped, as it is after Docker
Desktop quits; it never creates or reconfigures one.

Take an online snapshot before an upgrade:

```bash
mkdir -p ~/.local/state/ai-memory-backups
umask 077
ai-memory backup --to ~/.local/state/ai-memory-backups/pre-upgrade.tar.gz
ai-memory upgrade
ai-memory doctor
ai-memory status
```

Both current servers require bearer auth and remain loopback-only. Tokens stay
in owner-only local files, never in dotfiles, command arguments or harness
configs. A new `init` enables auth; an older install needs `ai-memory auth enable`
and a server restart. `/healthz` answers without a token; `/mcp` returning 401
without one is expected. The bootstrap refreshes integrations with upstream's
installers, then restores the Pi bridge guard to prevent duplicate capture.
Restart agents after applying it.

Zero-LLM capture and summaries, local embeddings, and upstream retention defaults
remain in place. LLM consolidation and review cost tokens and are opt-in; raw
observation pruning and destructive cleanup are not enabled. Pi's compact
routing block lives in `ai/pi/AGENTS.md`; its managed skills come from
`~/.claude/skills`. Claude Code on the Mac keeps its existing built-in memory
until that material has been curated and verified in ai-memory.

For cross-harness session continuity, upstream recommends
[`ai-memory run`](https://github.com/akitaonrails/ai-memory/blob/main/docs/managed-workstreams.md).
Direct launches still have capture and handoffs. The Mac and WSL currently keep
separate stores: shared cross-machine memory requires both clients to use one
authenticated server. Do not run two servers against one data directory or sync
live SQLite files between machines. See [usage](USAGE.md#ai-memory--memory-across-sessions).

## MCP configuration

`claude/mcp-servers.json` declares DeepWiki, Playwright Chromium and
codebase-memory-mcp. Pi receives these servers and the Stark server from
`pi/mcp.json`. Other plugin-provided MCPs remain owned by their plugins.
Pi's built-in codemode exposes MCP tools on demand; no separate codemode
package is needed.

An optional private `ai/work/` overlay adds employer-specific servers and
credential helpers. It is excluded from the public copy. Servers requiring
credentials should use dedicated read-only identities: a server's `--readonly`
flag does not restrict the identity itself.

## ai-jail

`ai-jail claude` runs Claude with the project directory writable, network on,
gh + ssh available, and the rest of `$HOME` hidden (see the header of
`ai-jail/<OS>.toml` for the exact list). Accident prevention, not a security
boundary — it is what makes `--dangerously-skip-permissions` tolerable.

- **macOS login:** Claude keeps its OAuth token in the Keychain, which the jail
  cannot reach (ai-jail issue #44). Once: `claude setup-token`, put
  `CLAUDE_CODE_OAUTH_TOKEN=<token>` in `~/.config/ai-jail/claude.env`
  (`chmod 600`), re-run the bootstrap — it adds `env_from_file` to `~/.ai-jail`.
  Linux keeps the token in `~/.claude/.credentials.json`, which the jail mounts.
- **codebase-memory-mcp is shared with the jail.** Its index cache and daemon
  rendezvous are relocated (`CBM_CACHE_DIR` / `CBM_RUNTIME_DIR` in
  `claude/settings.<OS>.json`) to `/opt/homebrew/var/codebase-memory-mcp` on
  macOS and `~/.local/state/codebase-memory-mcp` on Linux, and that directory is
  mapped read-write. The defaults could not work: CBM opens every directory from
  `/` down to its socket, and the jail denies opening `/private` on macOS and
  replaces `/tmp` on Linux. Every CBM process must see the same pair or it starts
  a second daemon: Claude reads it from `settings.json`, shells from
  `~/.config/ai/env.sh` (sourced by `~/.zshrc`), VS Code from its `mcp.json`. VS
  Code launched from the Dock does not get it for its Copilot hooks — launch it
  with `code` from a terminal. After moving, re-index each repo once.
- Browser MCPs (Playwright, Chrome DevTools) start in the jail; driving a real
  browser from there is untested.
- To keep local edits to `~/.ai-jail`, delete its first line; the bootstrap
  then leaves it alone.

## Auto-sync

`sync.sh` follows origin's default branch (`master` in the private repo,
`main` in the public repo). The bootstrap schedules it only in the owner's
private clone. In a public clone, review and apply updates by hand, or opt in
with `DOTFILES_AUTO_SYNC=1 ./ai/bootstrap.sh`.

When enabled, a LaunchAgent (`com.dnl1.dotfiles-sync`) on macOS or a systemd
user timer (`dotfiles-sync.timer`) on Linux checks every 15 minutes. The script
can also run by hand. Each run fetches the default branch and:

- **Nothing new** → exits silently, writes nothing. Being only *ahead* of origin
  (committed, not pushed yet) counts as nothing new.
- **Behind and clean** → `git merge --ff-only`. If `ai/` changed since the last
  successful bootstrap, it runs `bootstrap.sh` too; otherwise the pull alone is
  enough (symlinked dotfiles take effect at once; files `install-dotfiles.sh`
  copies still need it run by hand). Notifies either way.
- **Another branch, a modified tracked file, or diverged history** → touches
  nothing and notifies once. Untracked files do not block it.
- **Bootstrap failed** → notifies once per commit and retries on every run
  until it passes — even after a commit that reverts `ai/` to the last applied
  content, since the failed run may have left a step half-done.
- **Offline** → logs the fetch error once, no notification.

Auto-sync executes whatever reaches that branch, unattended. Enable it only
for a repository whose updates you trust.

| | macOS | Linux / WSL |
|---|---|---|
| Log | `~/Library/Logs/dotfiles-sync.log` | `~/.local/state/dotfiles-sync/sync.log` |
| Notification | Notification Center (`osascript`) | Windows toast via `powershell.exe` (best effort) |
| Run now | `launchctl kickstart gui/$(id -u)/com.dnl1.dotfiles-sync` | `systemctl --user start dotfiles-sync.service` |
| Pause | `launchctl bootout gui/$(id -u)/com.dnl1.dotfiles-sync` | `systemctl --user disable --now dotfiles-sync.timer` |

- State lives in `~/.local/state/dotfiles-sync/` on both: `applied` is the last
  commit the bootstrap applied (written by `sync.sh --mark-applied` at the end of
  every successful bootstrap, manual or not).
- When `sync.sh` runs the bootstrap it sets `DOTFILES_SYNC=1`, and the bootstrap
  then leaves the scheduler alone — reloading the LaunchAgent would kill the run
  executing it. A change to the schedule itself applies on the next manual run.
- The timer runs only while WSL is up (no linger); `OnStartupSec` catches up when
  it starts. launchd misses the intervals that fall while the Mac sleeps
  (`launchd.plist(5)`), so after waking it catches up within 15 minutes.
- Runs on macOS's `/bin/bash` 3.2 and builds its own `PATH` (Homebrew, nvm's
  default Node, `~/.local/bin`). On WSL that `PATH` deliberately leaves out
  `/mnt/c`, which would otherwise put the Windows `npm` ahead of nvm's.

## Worktree workflow

One bare-repo container per repo, one worktree per ticket, each in its own tmux
window with its own Claude Code session.

```
~/work/app/
├── .bare/              # the repository: objects, refs, stashes, remote
├── .git                # "gitdir: ./.bare"
├── .ai-memory.toml     # workspace + project for every worktree below
├── main/               # worktree; owns the real .env files
├── APP-1234/          # nt / nti
└── pr-1170/            # rv (detached)
```

| Command | What it does |
|---|---|
| `nt BRANCH [base]` | Worktree `<container>/BRANCH` (base `origin/main`), `.env*` symlinked from `main/`, `pnpm install`, codebase-memory index, tmux window `dev/BRANCH`. |
| `nti BRANCH [base]` | Same, with the ticket's ai-memory isolated in workspace `tkt-BRANCH`. |
| `rv N` | Detached worktree `pr-N` at PR #N's head, workspace `reviews`, window `rev/PR-N`. Re-run after a force-push to refresh (refuses a dirty tree). |
| `wtmerge` | In an `nti` worktree, with its session ended: moves its memory to the shared workspace. The shared project already exists, so ai-memory MERGES — only durable pages survive; the ticket's sessions and observations are purged. |
| `wtdone [-f]` | Removes the current worktree (never its branch), its index and its tmux window. Refuses a dirty tree without `-f`, and refuses `main/`. |

Things the helpers handle that are easy to get wrong:

- **A bare clone copies every remote branch as a stale local branch with no
  upstream.** `nt` on such a branch sets the upstream and fast-forwards it.
- **The helpers refuse outside a container** (no `.bare/`) rather than create
  worktrees inside an ordinary checkout.
- Production credentials do not belong in `.env`: `nt`/`rv` link `.env` into
  every worktree and agent session. Use a separate credential store.
- **`codebase-memory-mcp cli list_projects` must be read as `--format json`**:
  the tree view abbreviates shared path prefixes (`@0+suffix`) once several
  worktrees share a parent.
- **The codebase-memory hooks need the permanent daemon** (`daemon start`);
  `cbm-hook-augment.sh` starts it when its socket does not answer, and the first
  session after a restart goes without graph context once. Each Grep/Glob pays
  ~1 s for the graph lookup.
- **`~/.local/bin/install.sh` is codebase-memory-mcp's updater, and it is on
  PATH.** A bare `install.sh` runs it without `--skip-config`. On 2026-10-20 a
  `curl … | sh` line wrapped when pasted, and its second half, `install.sh | sh`,
  wired codebase-memory-mcp into pi, Codex and OpenCode and left a 0-byte
  binary. Re-run `bash ~/.local/bin/install.sh --skip-config`, then this script.

**Converting an existing checkout**, without losing stashes, local-only branches
or uncommitted work (`git clone --bare` loses all three):

```bash
git-to-bare-container ~/work/repos/app ~/work/app   # old path becomes a symlink to main/
printf 'workspace = "default"\nproject = "app"\n' > ~/work/app/.ai-memory.toml
```

It checksums refs, stashes and every worktree's HEAD and status before and after,
and stops on any difference. Close Claude sessions in the repo first. Afterwards:
index `main/`, delete the old path's index, and note that Claude Code's
auto-memory directory follows the `.bare` path
(`~/.claude/projects/-home-<user>-work-app--bare/`).

`gh` stays on the normal `~/.config/gh`; there is no per-directory GitHub account.

## Deliberately not synced

- `~/.claude.json` — OAuth tokens and local state. Never copy it between machines.
- `~/.pi/agent/mcp-auth.json` — Pi MCP OAuth credentials; authenticate locally.
- Permission posture (`permissions`, `skipDangerousModePermissionPrompt`) — decide per machine.
- Secrets. Everything under `~/.config/ai-mcp/` and `~/.config/ai-jail/` is created locally.
- `~/.config/secrets/` (mode 700): tokens kept out of `~/.zshrc` so they do not reach every shell and every agent session — e.g. `github.env`, loaded only with `source` where needed.

## After the first run

- Context7 needs a one-time login: `/mcp` → context7 → authenticate.
- In Pi, use `/login` for OpenAI Codex subscription access. Authenticate MCPs
  separately in each client (`/mcp login <server>` in Pi).
- Start `herdr` in a repository, then run `pi` inside a pane. The bootstrap
  registers herdr's integrations; `herdr integration status` checks them.
- WSL without systemd: set `systemd=true` under `[boot]` in `/etc/wsl.conf`, run `wsl --shutdown`, re-run the script.
- WSL + ai-jail: needs `bubblewrap`. `sudo` asks for a password, so install it as root from Windows: `wsl -d Ubuntu-24.04 -u root -- apt-get install -y bubblewrap`. The WSL kernel has no AppArmor LSM, so the Ubuntu 24.04 userns exception in the ai-jail README is not needed there.
- Updates: `ai-memory upgrade`, `bash ~/.local/bin/install.sh --skip-config` (codebase-memory-mcp), `claude plugin update <plugin>`, `brew upgrade ai-jail rtk uv`. After `ai-memory upgrade`, run `ai/bootstrap.sh`: the upgrade rewrites ai-memory's Claude Code hooks without the pi guard.
