# dotfiles

WSL/Ubuntu shell dotfiles, plus the AI coding setup I use on macOS and WSL:
[pi.dev](https://pi.dev) inside [herdr](https://herdr.dev), with ai-memory,
rtk, codebase-memory-mcp, MCP tools and shared skills.

## Pi + herdr

The shell installer below is for WSL/Ubuntu and installs pi with the rest of
the tools. The AI setup is a separate step that also supports macOS. It needs
Claude Code (authenticated), Node/npm, Python 3, jq, curl and git; macOS also
needs Homebrew. See [prerequisites and setup](ai/README.md) before running it.

```bash
# After cloning this repo (or using the shell installer below):
~/.dotfiles/ai/bootstrap.sh

# Then, in a repository:
herdr
pi     # run inside a herdr pane
```

The bootstrap installs pi, herdr and its agent integrations, ai-memory,
codebase-memory-mcp, rtk, uv and Playwright Chromium. It also configures the
Claude bridge, Codex subscription access, `pi-auto-model`, Humanizer, Stark,
status lines, quota fallback, clipboard support and Git/PR popups.
Use `gh auth login` for PRs; install lazygit separately for the Git popup.
Provider and MCP logins are per machine.

The configured base model is Claude Opus 5.5 at `xhigh`; automatic routing is
also enabled for new Pi sessions. Use `/auto-model off` and choose a concrete
model if you want to keep it fixed. State, OAuth tokens and sessions stay local.
Employer-specific settings are excluded from the public repo, and public
clones do not enable unattended auto-sync unless you opt in.

To drive pi from your phone away from home, see
[Phone access](#phone-access-tailscale--moshi).

[Daily usage](ai/USAGE.md) · [Configuration and updates](ai/README.md)

---

## Fonts (required for Powerlevel10k)

Powerlevel10k needs a **Nerd Font** to render icons and prompt symbols correctly.
Install the font **before** opening the terminal for the first time.

### WSL / Windows Terminal

1. Download the four **MesloLGS NF** font files:
   - [MesloLGS NF Regular.ttf](https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Regular.ttf)
   - [MesloLGS NF Bold.ttf](https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Bold.ttf)
   - [MesloLGS NF Italic.ttf](https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Italic.ttf)
   - [MesloLGS NF Bold Italic.ttf](https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Bold%20Italic.ttf)

2. Right-click each file → **Install for all users** (or double-click → Install).

3. In **Windows Terminal** → Settings → your Ubuntu profile → Appearance → set **Font face** to `MesloLGS NF`.

> **VS Code users:** add `"terminal.integrated.fontFamily": "MesloLGS NF"` to `settings.json`.

### Native Ubuntu (desktop)

```bash
mkdir -p ~/.local/share/fonts
curl -fsSL -o ~/.local/share/fonts/"MesloLGS NF Regular.ttf" \
  "https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Regular.ttf"
curl -fsSL -o ~/.local/share/fonts/"MesloLGS NF Bold.ttf" \
  "https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Bold.ttf"
curl -fsSL -o ~/.local/share/fonts/"MesloLGS NF Italic.ttf" \
  "https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Italic.ttf"
curl -fsSL -o ~/.local/share/fonts/"MesloLGS NF Bold Italic.ttf" \
  "https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Bold%20Italic.ttf"
fc-cache -fv
```

Then set your terminal emulator's font to **MesloLGS NF**.

---

## Install (one-liner)

**Prerequisite:** `curl` — the only thing you need on a fresh machine. `git` and `curl` are auto-installed if missing.

> Run **without** `sudo`. The script uses sudo internally only where needed. Running as root breaks installers like nvm, bun, and pnpm.

```bash
curl -fsSL https://raw.githubusercontent.com/dnl1/dotfiles/main/install.sh | bash
```

If the machine has `wget` instead of `curl`:

```bash
wget -qO- https://raw.githubusercontent.com/dnl1/dotfiles/main/install.sh | bash
```

Clones the repo to `~/.dotfiles` and runs the full bootstrap automatically.
Safe to re-run — resumes automatically from the last failed step.

To start over from scratch:

```bash
~/.dotfiles/setup.sh --reset
```

### What gets installed

| Tool | Purpose |
|------|---------|
| zsh + oh-my-zsh | Shell and plugin framework |
| tmux | Terminal multiplexer (`.tmux.conf`) |
| powerlevel10k | Fast, informative prompt theme |
| zsh-autosuggestions | Fish-like command suggestions as you type |
| zsh-syntax-highlighting | Colors commands green/red before you run them |
| eza | Modern `ls` replacement with icons and colors |
| bat | Modern `cat` replacement with syntax highlighting |
| zoxide | Smarter `cd` — jump to frecent directories with `z` |
| fzf | Fuzzy finder for history, files, and more |
| ripgrep | Faster `grep` alternative |
| jq | JSON processor, used by the AI setup and status lines |
| nvm + Node LTS | Node.js version manager |
| bun | Fast JS runtime and package manager |
| Go | Go toolchain |
| pnpm | Efficient Node package manager |
| pi | Coding agent ([pi.dev](https://pi.dev)); `ai/bootstrap.sh` adds herdr, MCPs and skills |
| opencode | AI coding agent (terminal-based) |
| gh | GitHub CLI — PRs, issues, repos from the terminal |
| Tailscale | Private network to reach this machine from the phone (see [Phone access](#phone-access-tailscale--moshi)) |
| mosh | Keeps a remote terminal alive across network changes and sleep |

### Manual install (dotfiles only)

```bash
git clone https://github.com/dnl1/dotfiles ~/.dotfiles
~/.dotfiles/install-dotfiles.sh --symlink   # symlink mode (recommended)
~/.dotfiles/install-dotfiles.sh             # copy mode
```

---

## Shell aliases and commands

### Git

| Command | Expands to | Description |
|---------|-----------|-------------|
| `gs` | `git status` | Working tree status |
| `ga` | `git add .` | Stage all changes |
| `gc "msg"` | `git commit -m "msg"` | Commit with message |
| `gp` | `git push` | Push to remote |
| `gl` | `git pull` | Pull from remote |
| `ggpush` | `git push origin <branch>` | Push current branch to origin (oh-my-zsh) |
| `ggpull` | `git pull origin <branch>` | Pull current branch from origin (oh-my-zsh) |
| `gprmain` | — | Open a PR against `main` using `gh` (custom function) |

> `ggpush` and `ggpull` are provided by the oh-my-zsh `git` plugin. Run `alias \| grep gg` to see all variants.

### Rebase (oh-my-zsh git plugin)

| Command | Expands to | When to use |
|---------|-----------|-------------|
| `grb origin/main` | `git rebase origin/main` | Replay your commits on top of latest main |
| `grb -X theirs origin/main` | `git rebase -X theirs origin/main` | Rebase and auto-resolve conflicts by taking the incoming (remote) side |
| `grb -X ours origin/main` | `git rebase -X ours origin/main` | Rebase and auto-resolve conflicts by keeping your changes |
| `grbi HEAD~3` | `git rebase -i HEAD~3` | Interactive rebase — squash, reorder, or edit last 3 commits |
| `grbm` | `git rebase $(main_branch)` | Rebase onto local main branch |
| `grbc` | `git rebase --continue` | Continue after resolving a conflict |
| `grba` | `git rebase --abort` | Abandon the rebase, return to pre-rebase state |
| `grbs` | `git rebase --skip` | Skip the current conflicting commit and continue |

**Common flow — sync feature branch with main:**

```bash
gl                        # pull latest on main first
git checkout feature/xyz
grb origin/main           # rebase feature on top of main
# if conflicts:
#   resolve files, then: git add <file> && grbc
#   or skip commit:      grbs
#   or bail out:         grba
gp --force-with-lease     # push rebased branch (safer than --force)
```

> `-X theirs` / `-X ours` are **strategy options** for the `ort` merge strategy used during each commit replay — "theirs" means the incoming base commit wins, "ours" means your replayed commit wins. These are the opposite of what you might expect from a merge perspective.

### Docker

| Command | Expands to | Description |
|---------|-----------|-------------|
| `dps` | `docker ps` | List running containers |
| `dcu` | `docker compose up -d` | Start services in detached mode |
| `dcd` | `docker compose down` | Stop and remove services |

### Filesystem

| Command | Expands to | Description |
|---------|-----------|-------------|
| `ls` | `eza --icons` | List files with icons |
| `ll` | `eza -lah --icons` | Long list, all files, human-readable sizes |
| `tree` | `eza --tree --icons` | Directory tree with icons |
| `cat` | `batcat` | Syntax-highlighted file viewer |
| `..` | `cd ..` | Go up one directory |
| `...` | `cd ../..` | Go up two directories |
| `z <dir>` | — | Jump to a frecent directory (zoxide) |
| `repos` | `cd ~/work/repos` | Jump to repos directory |

### AI

| Command | Description |
|---------|-------------|
| `herdr` / `pi` | Terminal workspace and coding agent (see Pi + herdr above) |
| `ai-team` | Deprecated OpenCode/tmux workflow; use pi inside herdr (see below) |
| `opencode` | Open the AI coding agent in the current directory |

### Misc (oh-my-zsh plugins)

| Plugin | What it adds |
|--------|-------------|
| `sudo` | Press `Esc` twice to prepend `sudo` to the last command |
| `extract` | `extract <file>` — extracts any archive format automatically |
| `history` | `h` to search history; `hs <term>` to grep history |
| `z` | `z <partial-name>` — jump to frecent directories |

---

## ai-team (deprecated)

> `ai-team` is no longer maintained. Use pi inside herdr instead ([Pi + herdr](#pi--herdr)).

Launches a tmux session with N `opencode` AI agents and a monitor pane where you can run shell commands freely.

```bash
ai-team              # 1 agent (dev) + monitor  ← default
ai-team 2            # 2 agents (dev + review) + monitor
ai-team 3            # 3 agents (dev + review + wildcard) + monitor
ai-team 3 "add auth" # 3 agents, each seeded with the given prompt
ai-team reset        # kill session and recreate with same agent count
ai-team reset 2      # kill session and recreate with 2 agents
```

**Agent roles:**

| Agent | Role |
|-------|------|
| `dev` | Senior backend engineer — implements features |
| `review` | Strict code reviewer — finds bugs and suggests improvements |
| `wildcard` | Problem solver — fixes tests, optimizes, debugs |

The session recreates automatically if the agent count changes or the layout version is bumped.

---

## Phone access (Tailscale + Moshi)

Run pi and herdr on your machine and use them from the phone anywhere, with no
public IP or port forwarding. Tailscale puts the phone and the machine on the
same private network, and [Moshi](https://getmoshi.app) (iOS and Android) is
the terminal: it attaches to herdr sessions, keeps them alive over mosh, and
shows pi's turns, approvals and notifications through its `moshi-hook`.

1. **Tailscale on both ends.** Install the Tailscale app on the phone and sign
   in. On the machine, sign in to the same account:
   - WSL/Ubuntu: `setup.sh` installs Tailscale and mosh. `tailscaled` needs
     systemd, which `repair-wsl-network.sh` enables. Then run
     `sudo tailscale up`.
   - macOS: `brew install --cask tailscale-app` (open the app and sign in) and
     `brew install mosh`.

   `tailscale status` shows the machine's MagicDNS name and
   `tailscale ip -4` its `100.x.y.z` address.
2. **SSH on the machine.** Moshi connects through the machine's own SSH
   server, carried by the Tailscale tunnel.
   - WSL/Ubuntu: `sudo apt install openssh-server`, then
     `sudo systemctl enable --now ssh`.
   - macOS: System Settings → General → Sharing → Remote Login.

   Leave *Tailscale SSH* (`tailscale up --ssh`) off. It takes over port 22,
   so Moshi's key login hangs for a minute and then fails with an auth error,
   and mosh cannot start through it. `sudo tailscale set --ssh=false` turns
   it off.
3. **Pair the phone.** Install `moshi-hook` on the machine and keep it
   running:
   - WSL/Ubuntu: `curl -fsSL https://getmoshi.app/install.sh | sh`, then
     `moshi-hook service install`.
   - macOS: `brew tap rjyo/moshi && brew trust rjyo/moshi &&
     brew install moshi-hook`, then `brew services start moshi-hook`.

   Run `moshi-hook host setup` and scan the QR code with Moshi's *Easy
   Pair*. It saves the connection and installs a key generated on the phone;
   anyone who scans the QR before it expires gets SSH access, so do not share
   it. Check that the saved host is the Tailscale name or `100.x` address,
   not the LAN IP, or it will only work at home.
4. **Agent notifications.** Copy the pairing token from Moshi's hook
   settings and run `moshi-hook pair --token <token>` and
   `moshi-hook install`. That adds hooks for pi
   (`~/.pi/agent/extensions/moshi-hooks.ts`) and Claude Code.
   `moshi-hook doctor` checks the daemon, pairing, hooks and herdr.

Day to day, start `herdr` on the machine and run pi in a pane. In Moshi, open
the connection and pick the herdr session; leave the connection type on
*Auto* so it uses mosh and survives switching between Wi-Fi and mobile data.

If Moshi does not list herdr sessions, herdr is probably missing from the
PATH of non-interactive SSH commands. `ssh <host> 'command -v herdr'` should
print its path; if it prints nothing, add
`export PATH="$HOME/.local/bin:$PATH"` to `~/.zshenv`. A Mac with the lid
closed sleeps and drops mosh sessions; Moshi wakes it when reconnecting, and
`caffeinate` (or Amphetamine) keeps it awake.

---

## WSL utilities

### fix-dns.sh

Runs automatically on every interactive shell start. Checks if `/etc/resolv.conf` has a nameserver and adds one if missing — prevents DNS failures after WSL restarts.

### repair-wsl-network.sh

Full network repair for WSL — rewrites `/etc/wsl.conf` to enable systemd and proper DNS, then removes the stale `resolv.conf` so Windows regenerates it.

```bash
sudo ~/.dotfiles/repair-wsl-network.sh
# then from PowerShell/CMD:
wsl --shutdown
```

---

## Files

| File | Description |
|------|-------------|
| `.zshrc` | Main zsh config — plugins, aliases, PATH, tool initialization |
| `.p10k.zsh` | Powerlevel10k prompt configuration |
| `.gitconfig` | Git user name and email |
| `.bashrc` / `.bash_logout` / `.profile` | Bash fallback config |
| `ai/` | Pi/herdr setup, shared skills, MCP configuration and bootstrap |
| `.tmux.conf` | tmux plugins and worktree workflow |
| `tests/` | Offline bootstrap, integration and sync checks |
| `ai-team.sh` | Deprecated tmux AI session script (see *ai-team*) |
| `fix-dns.sh` | WSL DNS auto-fix (runs on shell start) |
| `repair-wsl-network.sh` | Full WSL network repair |
| `install.sh` | curl one-liner — clones repo and runs setup |
| `install-dotfiles.sh` | Copies or symlinks dotfiles into `$HOME` with backup |
| `setup.sh` | Full machine bootstrap with resumable step tracking |
