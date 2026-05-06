# dotfiles

WSL/Ubuntu dotfiles — zsh + oh-my-zsh + powerlevel10k, tmux, AI coding setup.

## Install (one-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/dnl1/dotfiles/master/install.sh | bash
```

Clones the repo to `~/.dotfiles` and runs the full bootstrap automatically.

## What gets installed

| Tool | Purpose |
|------|---------|
| zsh + oh-my-zsh | shell |
| powerlevel10k | prompt theme |
| zsh-autosuggestions + zsh-syntax-highlighting | shell plugins |
| eza, bat, zoxide, fzf, ripgrep | modern CLI replacements |
| nvm + Node LTS | Node version manager |
| bun | fast JS runtime / package manager |
| Go | Go toolchain |
| pnpm | alternative Node package manager |
| opencode | AI coding agent |
| gh | GitHub CLI |

## Manual install (dotfiles only)

```bash
git clone https://github.com/dnl1/dotfiles ~/.dotfiles
~/.dotfiles/install-dotfiles.sh --symlink
```

## Files

| File | Purpose |
|------|---------|
| `.zshrc` | zsh config — aliases, plugins, PATH, tools |
| `.p10k.zsh` | Powerlevel10k prompt config |
| `.gitconfig` | git user config |
| `.bashrc` / `.profile` | bash fallback config |
| `ai-team.sh` | tmux layout with N opencode agents + monitor pane |
| `fix-dns.sh` | auto-fix WSL DNS on shell start |
| `repair-wsl-network.sh` | full WSL network repair (run with sudo) |
| `install.sh` | curl one-liner bootstrap |
| `install-dotfiles.sh` | copy or symlink dotfiles into `$HOME` |
| `setup.sh` | full machine bootstrap script |

## ai-team

Launches a tmux session with `opencode` agents and a monitor pane.

```bash
ai-team           # 1 agent + monitor (default)
ai-team 2         # 2 agents + monitor
ai-team 3         # 3 agents + monitor
ai-team 3 "add auth"  # 3 agents, seeded with a prompt
ai-team reset     # kill and recreate
ai-team reset 2   # kill and recreate with 2 agents
```

Agents: **dev** (engineer) · **review** (code reviewer) · **wildcard** (problem solver)
