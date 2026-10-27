# Using the AI tools

Day-to-day guide to what `ai/bootstrap.sh` installs. Installation, credentials
and how each piece is wired live in [README.md](README.md); this file is about
using them. Everything here works the same on the Mac and on WSL unless a line
says otherwise.

| Tool | What it does for you | What you do |
|---|---|---|
| [ai-memory](#ai-memory--memory-across-sessions) | Records every session; hands context to the next one | Ask for a handoff; ask about past work |
| [codebase-memory-mcp](#codebase-memory-mcp--code-graph) | Call graph of each indexed repo | Ask structural questions; index new repos once |
| [Worktrees](#worktrees--one-per-ticket) | One worktree, tmux window and Claude session per ticket | `nt` / `rv` / `wtdone` |
| [herdr](#herdr--git-and-pr-popups) | lazygit and the current repository's PRs over the agent panes | Ctrl+B, Ctrl+G for Git; Ctrl+B, Ctrl+P for PRs |
| [Local coding](#local-coding-on-the-mac) | Devstral through Ollama and a lean pi profile | `llm-mode on` / `code` / `off` (Mac only) |
| [rtk](#rtk--compact-command-output) | Shrinks command output before it reaches the model | Nothing; `rtk gain` to see the savings |
| [ai-jail](#ai-jail--sandboxed-sessions) | Runs the agent with most of `$HOME` hidden | `ai-jail claude` |
| [MCP servers](#mcp-servers) | Docs, browser automation, code graph and Stark | Ask in plain language |
| [Plugins](#plugins) | Workflow skills, LSP, security review | Mostly automatic |
| [Auto-sync](#keeping-both-machines-in-step) | Applies changes from origin's default branch | Opt-in in public clones |

## Starting a session

```bash
herdr                                            # terminal workspace
pi                                               # start inside a pane
claude                                           # standalone Claude Code
ai-jail claude                                   # sandboxed session (see ai-jail)
ai-jail claude --dangerously-skip-permissions    # sandboxed, no permission prompts
```

The status line shows the model and effort level, context used, the worktree,
the session cost, and the 5-hour / 7-day rate-limit usage with reset times.
The configured base model is Opus 5.5 at `xhigh` effort
(`claude/settings.base.json`, `pi/settings.base.json`). Pi also installs
`pi-auto-model@0.9.1`, which enables routing by default for new sessions.
Use `/auto-model status` to inspect it, or `/auto-model off` and select a
concrete model to keep a session fixed. Log in to each provider on that machine;
credentials and routing history are not synced.

The pool lives in `pi/auto-model.json`. Your prompts go to Opus 5.5 first, and
Luna 5.6 and Sol 6.1 take over when it fails. `/auto-model pool gpt-sol` keeps a
session on Sol, `/auto-model pool claude` on Opus, and `/auto-model pool general`
restores the mix. The Claude subscription is still picked with `/conta trabalho`
or `/conta pessoal`. The local Devstral never answers your prompts; on the Mac it
is only preferred for turns started by extensions (see below).

## ai-memory — memory across sessions

One authenticated loopback server runs on each machine at
`http://127.0.0.1:49374`. The Mac and WSL have separate stores. To share memory
between machines, both clients must point at one authenticated server; syncing
dotfiles alone does not share memory.

Lifecycle hooks record prompts and tool events under the project, keyed by the
repo root so worktrees share a project. Session summaries and search work with
no LLM calls; embeddings run locally. ai-memory does not reset the agent's
context window: compaction is controlled by Pi or Claude Code.

For continuity when switching agents, use upstream's preferred launcher:

```bash
ai-memory run pi
ai-memory run claude
ai-memory run codex
ai-memory continue               # resume the newest managed workstream
```

Each `run` command starts or resumes the checkout's workstream in that agent.
Direct `pi` and `claude` launches still capture sessions and exchange handoffs,
but do not add managed native-history continuity. In a session, ask:

- "Hand this off" when finishing. The next session receives the handoff once.
- "Have we discussed X?" to search prior work (`memory_query`, `memory_recent`).
- "Remember that ..." to save a durable wiki page (`memory_write_page`).

Pi loads its compact routing block from `~/.pi/agent/AGENTS.md` and managed
skills from `~/.claude/skills`. Its generated extension captures Pi's events and
bridges memory tools with the session id; there is no second ai-memory MCP
registration. Claude's hooks skip Pi bridge turns to avoid duplicate records.

Claude Code's built-in memory is off on WSL (`claude/settings.Linux.json`);
its earlier notes were migrated on 2026-10-05 and remain on disk as an archive.
The Mac keeps built-in memory on until its notes have been curated and verified
in ai-memory, so it gets no conflicting routing block in `~/.claude/CLAUDE.md`.
OpenCode integration is refreshed only when its runtime is available.

```bash
ai-memory status                 # actual server version, counts, auth and health
ai-memory doctor                 # capture coverage, policy and pending spool
ai-memory search "nacha batch"   # full-text search of the wiki
ai-memory handoffs               # open handoffs (cancel a stale one by id)
umask 077
ai-memory backup --to ~/ai-memory-backup.tar.gz
```

On WSL the server runs in Docker; the wrapper uses a native host client for
capture and managed launches. Quitting Docker Desktop stops the container, and
it stays stopped when Docker starts again: run `docker start ai-memory` or the
bootstrap. Meanwhile hooks queue events locally and send them once the server
answers. On the Mac it runs as a native LaunchAgent.
Both require a bearer read from owner-only local files. `/healthz` is public;
unauthenticated `/mcp` requests return 401. The WSL web UI is at
<http://127.0.0.1:49374/web> and requires authentication. Restart agents after
changing hooks, skills or MCP registration.

## codebase-memory-mcp — code graph

Indexes a repository into a graph of functions, classes, calls and imports.
A git watcher keeps indexed repos current; repos that were never indexed are not
picked up on their own.

**In Claude, ask structural questions** — who calls this, what does it call,
trace this flow, what is dead code, what is the architecture. Claude answers
from the graph (`search_graph`, `trace_path`, `get_code_snippet`,
`get_architecture`, `query_graph`) instead of grepping, and falls back to
reading files where the graph has gaps. Hooks from `claude/hooks/` add a
reminder at session start and graph hints to every Grep and Glob (about 1 s
each). They need the permanent daemon; the hook starts it when its socket does
not answer, so the first session after a restart goes without hints once.

The installer runs with `--skip-config`, so there is no Bash hook, skill or
subagent. On a machine installed before that (the Mac), the bootstrap removes
what the installer had wired into Claude Code: its `hook-augment` hooks
(including the Bash one), the `codebase-memory` skill and its three agents. The
MCP entry comes from `mcp-servers.json`; OpenCode and VS Code keep the
installer's setup.

**Index a new repo once:**

```bash
cd ~/work/repos/<repo>
codebase-memory-mcp cli index_repository --repo-path "$PWD"
```

**From the terminal** — project names come from the path
and there is one index per worktree (`Users-user-work-repos-app` on the Mac;
on WSL app is a bare-repo container, so `home-user-work-app-main` for `main/`):

```bash
codebase-memory-mcp cli list_projects
codebase-memory-mcp cli search_graph --project Users-user-work-repos-app --name-pattern handleRequest
codebase-memory-mcp cli trace_path --project Users-user-work-repos-app \
  --function-name handleRequest --direction inbound --depth 1
codebase-memory-mcp cli <tool> --help        # flags for any tool
```

Graph visualisation: <http://127.0.0.1:9749/>.

If results look stale or a project seems missing, the shell probably lacks
`CBM_CACHE_DIR` / `CBM_RUNTIME_DIR` and started a second, empty daemon. Run
`. ~/.config/ai/env.sh` and try again (`~/.zshrc` sources it in new shells).

## Worktrees — one per ticket

Repos converted to a bare-repo container (`~/work/app/{.bare,main,…}`) get one
worktree per ticket, each in its own tmux window. Run these from any worktree
of the container; README, *Worktree workflow*, covers the layout and conversion.

```bash
nt APP-1234           # new worktree, .env links, pnpm install, graph index, tmux window
nti APP-1234          # same, with the ticket's ai-memory kept apart until wtmerge
rv 42                 # review PR #42 (re-run after a force-push)
wtdone                # remove worktree, index and window; keep the branch
```

Private shell helpers can be installed into `~/.config/zsh/devenv.d/*.zsh`.
`devenv.zsh` loads them when present; the public setup requires none.

## herdr — Git and PR popups

- `Ctrl+B`, then `Ctrl+G`: lazygit in the focused pane's directory. Esc at
  lazygit's top level closes the popup.
- `Ctrl+B`, then `Ctrl+P`: gh-dash with that repository's open PRs, including
  other authors', plus sections for your PRs and review requests. Press `Esc`
  to close it, `/` to search, or `?` for help.

The PR popup resolves the GitHub repository from the focused pane's directory,
even if the pane inherited a different `GH_REPO`. In a folder that only groups
clones (like `~/work/repos/studio-scheduler`), it shows the PRs of every clone
directly inside it, through a copy of the config in `~/.cache/herdr/` whose
filters name each repository. Anywhere else it says so and waits for Enter,
rather than showing a global dashboard (or closing before the message can be
read).

The bootstrap installs gh-dash v4.26.2 as a GitHub CLI extension. It needs `gh`
and an authenticated account (`gh auth login`). To install it by hand:

```bash
gh extension install dlvhdr/gh-dash --pin v4.26.2
```

The bindings live in `herdr/config.toml`; dashboard sections live in
`gh-dash/config.yml`; lazygit's Esc behaviour lives in `lazygit/config.yml`.
All three are linked into this repo. Commit and push edits to sync them to the
other machine. A running herdr picks up binding changes after
`herdr server reload-config`.

### Copying between machines

When herdr is attached to another machine, OSC 52 sends copied text to the
viewing machine's clipboard. This works from a Mac viewing WSL and from
Windows viewing a Mac.

- Copies made in pi also reach the viewing machine's clipboard.
  `pi/extensions/herdr-clipboard.ts` enables OSC 52 in herdr panes;
  run `/reload` in sessions that were already open when it was installed.
- `wclip` copies a command's output or files: `git diff | wclip`,
  `wclip notes.txt`. An agent can run it too; it writes to the agent's pane.
- `Ctrl+B`, then `[`: herdr's copy mode. `v` starts the selection, `y` copies.
- In Windows Terminal, holding Shift while dragging uses the terminal's own selection.

`ai/bootstrap.sh` installs the extension and `wclip` on each machine. These
files are linked to the dotfiles repository; no per-session setup is needed
for new pi sessions. To test, run `printf 'Clipboard test' | wclip` in the
remote pane and paste into an app on the viewing machine (Cmd+V on macOS).

OSC 52 has no acknowledgement, so `wclip` only confirms that it sent the text.
Payloads above about 75 KB are refused.

## Local coding on the Mac

`llm-mode` runs Devstral Small 2 locally without changing the model used by
ordinary pi sessions. Use it from a Mac pane in herdr or a terminal on the Mac.
In automatic routing, `configure` also makes Devstral the preferred model for
turns started by extensions, never for your prompts; while its server is off,
those turns fail over to the cloud models.

First setup (about 15 GB of model downloads):

```bash
brew install ollama
llm-mode prepare
```

In the repository you want to work on:

```bash
llm-mode on       # asks before requesting that Brave, Discord and Slack quit
llm-mode code     # starts pi with the local Devstral model
llm-mode status   # shows the mode, loaded models and swap usage
llm-mode off      # stops the managed Ollama server and reopens those apps
```

`code` enters the mode if needed and stays on the local model. To allow an
automatic return to Claude after its quota resets, opt in explicitly:

```bash
llm-mode code --wait-claude
```

This loads only the Claude provider and quota-return extension. It starts on
Devstral, selects Claude only while idle after the retry deadline, and falls back
to Devstral if Claude is still blocked. The next real request confirms quota;
there are no probe prompts. If this session has no reset headers, the first
selection attempt waits five minutes. Use `/claude-return status`, `on` or `off`
to control the wait. A manual model change also disables automatic return.
Opting in allows subsequent prompts and tool results to be sent to Claude.

Exit pi before running `off`. No apps are force-quit: save dialogs can block
entry, and `off` can recover an interrupted entry. Reopening an app does not
guarantee restoration of its previous windows or calls; check browser forms,
downloads and calls before confirming. Terminals, herdr, IDEs, VMs and existing
coding agents are never in the quit list.

The profile uses 16K context, at most 4K output tokens, one loaded model and one
request at a time, flash attention and a Q8 KV cache. `on` does not preload the
model; the first request loads it, and five idle minutes unload it. The server
listens only on loopback, has cloud features disabled and does not start at login.
Pi keeps its context files and four coding tools, but this profile disables
extensions, MCP and skills to limit prompt size. `--wait-claude` loads the two
extensions described above; MCP and skills stay disabled. The Devstral-only
compaction override reserves 4K tokens and keeps about 4K recent tokens, so the
16K profile compacts above 75% usage. Other models keep their existing settings.
The agent can still execute commands requested by the user; it is not a sandbox.

Settings live in `ai/ollama/llm-mode.json`, linked at
`~/.config/ai/llm-mode.json`. The quit list can be reduced to a subset of the
three apps. After changing context or output limits, run `off`, `configure`, then
`prepare` to rebuild the local model alias. The bootstrap installs the helper and
adds an `ollama-local` provider to pi; it never installs Ollama, downloads weights
or closes apps during a sync. Test the helper with
`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_llm_mode.py`.

## rtk — compact command output

**Automatic.** A global hook rewrites the Bash commands Claude runs (`git`,
`pnpm`, `tsc`, `vitest`, `prisma`, `docker`, `gh`, …) into rtk equivalents that
drop noise and keep every error, which saves context and tokens.

```bash
rtk gain                 # tokens saved so far
rtk gain --history       # per-command history
rtk discover             # commands that could have been compacted but were not
rtk proxy <cmd>          # run unfiltered (when a result looks empty or garbled)
rtk recall <hash>        # get back what a filter elided ("[+N hidden: rtk recall …]")
```

It is just as useful by hand: `rtk git status`, `rtk pnpm type-check`,
`rtk vitest run`.

## ai-jail — sandboxed sessions

`ai-jail claude` starts Claude with:

- the project directory writable;
- the network on;
- `gh` and `ssh` available, so it can push and open PRs;
- ai-memory, the Node / uv / Playwright caches and the codebase-memory index
  reachable;
- `~/.config/ai-mcp` read-only;
- the rest of `$HOME` hidden, and `~/.aws` deliberately not mapped.

It prevents accidents but is not a security boundary. It is what makes
`--dangerously-skip-permissions` tolerable.

```bash
ai-jail claude                 # Claude in the jail (flags after it go to claude)
ai-jail bash                   # a jailed shell, to see what the agent sees
ai-jail status                 # the effective config
```

The config is `~/.ai-jail`, rendered from `ai-jail/<OS>.toml`. Edit the template
and re-run the bootstrap; editing `~/.ai-jail` directly needs its first line
removed, or the next bootstrap overwrites it. macOS needs a one-time token for
Claude to log in from inside the jail (README, *ai-jail*).

## MCP servers

Ask in plain language. Pi exposes MCP tools through its built-in codemode;
Claude Code uses its MCP registrations.

| Server | Use it for |
|---|---|
| `deepwiki` | Documentation and questions about public GitHub repositories |
| `playwright` | Open Chromium, fill forms, click and take screenshots |
| `codebase-memory-mcp` | Symbols, call paths and the indexed code graph |
| `stark` | Accessibility tools and skills from the pinned Stark package in Pi |
| `ai-memory` | Session history and durable notes, via its native Pi extension |

Claude plugins can add their own servers. The optional private work overlay
adds other servers; its configuration and credentials are not published.
Authenticate MCPs in each client and on each machine. In Pi, use `/reload`
after setup and `/mcp login <server>` for an OAuth server. Gmail, Drive and
Calendar connectors belong to the claude.ai account, not these dotfiles.

## Plugins

| Plugin | What you notice | How to use it |
|---|---|---|
| `superpowers` | Claude announces *"Using brainstorming / systematic-debugging / …"* and follows a process: design before building, a plan for big work, TDD, verification before saying "done" | Automatic. Say so when you want to skip it for a quick change |
| `claude-md-management` | — | `/claude-md-management:revise-claude-md` saves what a session learned into CLAUDE.md; *"audit the CLAUDE.md files"* runs the improver |
| `security-guidance` | Warnings when an edit matches a risky pattern, and a security review when Claude stops (this costs tokens) | Automatic |
| `typescript-lsp` | Claude jumps to definitions, finds references and reads TS diagnostics instead of grepping | Automatic in TypeScript repos |
| `chrome-devtools-mcp` | Skills for a11y audits, LCP, memory leaks, cookies | *"Audit this page's accessibility"* |
| `context7` | See MCP servers | |

## OpenCode

ai-memory and codebase-memory-mcp are wired into OpenCode too. `ai-team`
starts a tmux session of OpenCode agents (root README, *ai-team*). Run
`ai-memory doctor` in a repo to confirm its sessions are being captured.

## Keeping both machines in step

- **Change the setup in the dotfiles, never by hand.** Edit
  `claude/plugins.txt`, `claude/mcp-servers.json` or `bootstrap.sh`, commit and
  push to origin's default branch. With auto-sync enabled, the other machine
  picks it up within 15 minutes; public clones require opt-in. See README,
  *Auto-sync*.
- A `claude mcp add` or `claude plugin install` made by hand stays on that one
  machine, and an MCP entry whose name is in `mcp-servers.json` is replaced on
  the next bootstrap.
- To apply a change right away, run the bootstrap on the machine you are on:
  `~/work/repos/.dotfiles/ai/bootstrap.sh` on the Mac,
  `~/.dotfiles/ai/bootstrap.sh` on WSL.
- After any change, restart open Claude Code sessions so they reload settings,
  plugins and MCP servers.

## When something is off

| Symptom | Check |
|---|---|
| ai-memory tools fail or no handoff arrives | `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:49374/healthz` should print `200`; `/mcp` without a token returns `401`. Restart on the Mac: `launchctl kickstart -k gui/$(id -u)/com.github.akitaonrails.ai-memory`; on WSL: `docker restart ai-memory` |
| An agent's sessions are not in ai-memory | `ai-memory doctor` in that repo names the missing hook and the command that installs it |
| Code graph answers are stale or empty | `. ~/.config/ai/env.sh`, then `codebase-memory-mcp cli index_status --project <name>`; re-index if needed |
| A command's output looks empty or garbled | Re-run it as `rtk proxy <cmd>` |
| Claude says a call was *Blocked by block-secret-reads.py* | It would have printed a secret. Use it without reading it (`--env-file=.env`, `DOTENV_CONFIG_PATH=…`), or run that one command in your own terminal |
| An MCP server shows *Needs authentication* or *Failed* | `/mcp` in Claude; `claude mcp list` from the terminal |
| A pushed change did not arrive on the other machine | Mac `~/Library/Logs/dotfiles-sync.log`; WSL `~/.local/state/dotfiles-sync/sync.log` |
| No graph hints at session start | `codebase-memory-mcp daemon status`; the hook starts the daemon when it is down — give it ~15 s |
| Tools need updating | README, *After the first run*: `ai-memory upgrade`, `bash ~/.local/bin/install.sh --skip-config` (codebase-memory-mcp), `claude plugin update <plugin>`, `brew upgrade ai-jail rtk uv` |
