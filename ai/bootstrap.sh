#!/usr/bin/env bash
# AI coding setup shared by the Mac and WSL: Claude Code settings, plugins,
# MCP servers, ai-memory (one local server per machine), codebase-memory-mcp
# and rtk. Every step checks before it acts, so re-running is safe.
#
# Usage:
#   ~/work/repos/.dotfiles/ai/bootstrap.sh     (Mac)
#   ~/.dotfiles/ai/bootstrap.sh                (WSL)
#
# sync-public.sh copies this directory to the PUBLIC dnl1/dotfiles repo, except
# ai/work/: the employer-specific MCP servers, credentials helpers and docs. That
# overlay is sourced below when it exists, so a public clone runs without it.

set -euo pipefail

AI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS="$(uname -s)"
ARCH="$(uname -m)"
AIM_PORT=49374

if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BOLD=''; DIM=''; RESET=''
fi

step() { echo -e "\n${BOLD}▸ $1${RESET}"; }
ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
skip() { echo -e "  ${DIM}· $1${RESET}"; }
warn() { echo -e "  ${YELLOW}⚠${RESET} $1"; }
die()  { echo -e "  ${RED}✗ $1${RESET}" >&2; exit 1; }

sha256_of() {
  if command -v sha256sum &>/dev/null; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# /mcp requires authentication on current installs; /healthz is the public probe.
aim_server_healthy() {
  [ "$(curl --max-time 3 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$AIM_PORT/healthz" || true)" = 200 ]
}

# ── Preflight ─────────────────────────────────────────────────────────────────

step "Preflight"
case "$OS" in Darwin|Linux) ;; *) die "unsupported OS: $OS" ;; esac
for bin in claude curl git python3 jq patch; do
  command -v "$bin" &>/dev/null || die "$bin not found on PATH"
done
mkdir -p "$HOME/.local/bin"
ok "$OS/$ARCH, claude $(claude --version 2>/dev/null | awk '{print $1}')"

# ── Claude Code settings ──────────────────────────────────────────────────────
# Merges only the keys in settings.base.json, then settings.<OS>.json (with
# __HOME__ substituted). Hooks are left alone: ai-memory and
# codebase-memory-mcp write them with machine-specific paths.

step "Claude Code settings"
mkdir -p "$HOME/.claude"
install -m 0755 "$AI_DIR/claude/statusline-command.sh" "$HOME/.claude/statusline-command.sh"
python3 - "$HOME" "$HOME/.claude/settings.json" "$AI_DIR/claude/settings.base.json" "$AI_DIR/claude/settings.$OS.json" <<'PY'
import json, os, shutil, sys, time
home, target_path, layer_paths = sys.argv[1], sys.argv[2], sys.argv[3:]
current = json.load(open(target_path)) if os.path.exists(target_path) else {}

def merge(dst, src):
    for key, value in src.items():
        if isinstance(value, dict) and isinstance(dst.get(key), dict):
            merge(dst[key], value)
        else:
            dst[key] = value
    return dst

merged = json.loads(json.dumps(current))
for path in layer_paths:
    if os.path.exists(path):
        merge(merged, json.loads(open(path).read().replace("__HOME__", home)))
if merged == current:
    print("  · settings.json already matches the settings layers")
else:
    if os.path.exists(target_path):
        shutil.copy2(target_path, f"{target_path}.bak-{int(time.time())}")
    with open(target_path, "w") as f:
        json.dump(merged, f, indent=2)
        f.write("\n")
    print("  \033[0;32m✓\033[0m merged the settings layers into settings.json (backup kept)")
PY

# Writing rule (humanizer) imported from ~/.claude/CLAUDE.md, the same way rtk
# imports its RTK.md.
install -m 0600 "$AI_DIR/claude/WRITING.md" "$HOME/.claude/WRITING.md"
if grep -qxF '@WRITING.md' "$HOME/.claude/CLAUDE.md" 2>/dev/null; then
  skip "@WRITING.md already imported by ~/.claude/CLAUDE.md"
else
  printf '@WRITING.md\n' >> "$HOME/.claude/CLAUDE.md" && ok "imported ~/.claude/WRITING.md from ~/.claude/CLAUDE.md"
fi

# Global skills, one directory each under claude/skills/. The installed copy is
# replaced whenever it differs, like WRITING.md: edit a skill here, not in
# ~/.claude/skills, or the next run puts the repo's version back.
for src in "$AI_DIR"/claude/skills/*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  dst="$HOME/.claude/skills/$name"
  if diff -rq "$src" "$dst" &>/dev/null; then
    skip "skill $name up to date"
  else
    mkdir -p "$HOME/.claude/skills"
    rm -rf "$dst" && cp -R "${src%/}" "$dst" && ok "skill $name installed in ~/.claude/skills"
  fi
done

# ── ai-memory ─────────────────────────────────────────────────────────────────
# Keep the existing deployment and data directory. Native init enables bearer
# auth; older installs can use `ai-memory auth enable` after taking a backup.
# Zero-LLM capture and local embeddings are the upstream defaults.

step "ai-memory"
if [ "$OS" = Darwin ]; then
  AIM_HOME="$HOME/Applications/ai-memory"
  case "$ARCH" in arm64) AIM_ASSET=ai-memory-macos-aarch64.tar.gz ;; *) AIM_ASSET=ai-memory-macos-x86_64.tar.gz ;; esac
else
  AIM_HOME="$HOME/.local/opt/ai-memory"
  case "$ARCH" in aarch64|arm64) AIM_ASSET=ai-memory-linux-aarch64.tar.gz ;; *) AIM_ASSET=ai-memory-linux-x86_64.tar.gz ;; esac
fi
AIM="$AIM_HOME/ai-memory"

# An ai-memory installed some other way (the Docker wrapper, a package) keeps
# its own binary, data and server: installing a second one would replace the
# `ai-memory` on PATH and fight it for the port. Only the wiring is checked.
aim_on_path="$(command -v ai-memory || true)"
if [ ! -x "$AIM" ] && [ -n "$aim_on_path" ] && [ "$(readlink -f "$aim_on_path")" != "$AIM" ]; then
  skip "existing ai-memory at $aim_on_path ($("$aim_on_path" --version 2>/dev/null | grep -v INFO | head -1)) — its install and server are left alone"
  AIM_CLI=("$aim_on_path")
elif [ -x "$AIM" ]; then
  skip "binary present ($("$AIM" --version 2>/dev/null)) — update with: ai-memory upgrade"
else
  tmp="$(mktemp -d)"
  base_url="https://github.com/akitaonrails/ai-memory/releases/latest/download/$AIM_ASSET"
  curl -fsSL "$base_url" -o "$tmp/$AIM_ASSET"
  curl -fsSL "$base_url.sha256" -o "$tmp/$AIM_ASSET.sha256"
  [ "$(sha256_of "$tmp/$AIM_ASSET")" = "$(awk 'NR==1{print $1}' "$tmp/$AIM_ASSET.sha256")" ] \
    || die "ai-memory checksum mismatch"
  mkdir -p "$AIM_HOME"
  tar -xzf "$tmp/$AIM_ASSET" -C "$AIM_HOME"
  rm -rf "$tmp"
  ok "installed $("$AIM" --version) to $AIM_HOME"
fi

if [ "${AIM_CLI+set}" = set ]; then
  # External install: no symlink, no service. Quitting Docker Desktop stops the
  # wrapper's container, and the next engine start leaves it stopped. Start an
  # existing stopped container; never create or reconfigure one.
  if command -v docker &>/dev/null \
      && [ "$(docker inspect --format '{{.State.Running}}' ai-memory 2>/dev/null || true)" = false ]; then
    if docker start ai-memory >/dev/null; then
      ok "started the stopped ai-memory container"
    else
      warn "could not start the ai-memory container — run: docker start ai-memory"
    fi
  fi
elif [ "$OS" = Darwin ]; then
  ln -sf "$AIM" "$HOME/.local/bin/ai-memory"
  AIM_CLI=("$AIM")
  [ -f "$HOME/Library/Application Support/ai-memory/config.toml" ] || "$AIM" init >/dev/null 2>&1 \
    || die "ai-memory init failed"
  label=com.github.akitaonrails.ai-memory
  plist="$HOME/Library/LaunchAgents/$label.plist"
  if launchctl print "gui/$(id -u)/$label" &>/dev/null; then
    skip "LaunchAgent already loaded"
  else
    mkdir -p "$HOME/Library/Logs/ai-memory" "$HOME/Library/LaunchAgents"
    sed -e "s|__AI_MEMORY_BIN__|$AIM|" -e "s|__HOME__|$HOME|" \
      "$AIM_HOME/packaging/launchd/$label.plist" > "$plist"
    launchctl bootstrap "gui/$(id -u)" "$plist"
    ok "LaunchAgent loaded"
  fi
else
  ln -sf "$AIM" "$HOME/.local/bin/ai-memory"
  # Same layout as the packaged user unit: data in ~/.local/share, config in ~/.config.
  AIM_FLAGS=(--data-dir "$HOME/.local/share/ai-memory" --config "$HOME/.config/ai-memory/config.toml")
  AIM_CLI=("$AIM" "${AIM_FLAGS[@]}")
  mkdir -p "$HOME/.local/share/ai-memory" "$HOME/.config/ai-memory"
  [ -f "$HOME/.config/ai-memory/config.toml" ] || "${AIM_CLI[@]}" init >/dev/null 2>&1 \
    || die "ai-memory init failed"
  if systemctl --user show-environment &>/dev/null; then
    unit="$HOME/.config/systemd/user/ai-memory.service"
    if [ -f "$unit" ]; then
      skip "systemd user unit present"
    else
      mkdir -p "$(dirname "$unit")"
      sed -e "s|/usr/bin/ai-memory|$AIM|" "$AIM_HOME/packaging/systemd/ai-memory-user.service" > "$unit"
      systemctl --user daemon-reload
      ok "systemd user unit written"
    fi
    systemctl --user enable --now ai-memory.service >/dev/null 2>&1 \
      || warn "could not start ai-memory.service — see: journalctl --user -u ai-memory"
  else
    warn "systemd is not running (WSL: set systemd=true under [boot] in /etc/wsl.conf, then wsl --shutdown)."
    warn "Until then, start the server by hand: ai-memory ${AIM_FLAGS[*]} serve --transport http"
  fi
fi

for _ in $(seq 1 15); do
  aim_server_healthy && break
  sleep 1
done
if aim_server_healthy; then
  ok "server answering on 127.0.0.1:$AIM_PORT"
  # Refresh owned registrations on every apply, including after an upgrade.
  # The current Docker wrapper selects checksum-verified native host capture;
  # legacy shell hooks cannot enforce capture exclusions before transmission.
  "${AIM_CLI[@]}" install-hooks --agent claude-code --project-strategy repo-root --apply
  "${AIM_CLI[@]}" install-mcp --client claude-code --session-aware --apply
  # ai-memory is the memory of record: its routing block goes in the GLOBAL
  # ~/.claude/CLAUDE.md (never a repo's — without --target it writes into the
  # CLAUDE.md/AGENTS.md of the current directory) and its skills in ~/.claude/skills.
  "${AIM_CLI[@]}" install-skills --scope global --agent claude-code
  # Only where Claude's built-in memory is off (settings.<OS>.json): the block
  # says not to keep durable facts in harness-local memory, which contradicts a
  # built-in memory that is still on. The Mac keeps built-in memory for now.
  # A block found where built-in memory is on is REMOVED, not just left: the
  # Mac's auto-sync installed one before this gate existed. ai-memory has no
  # removal command, so the markers and what they enclose are cut out here.
  aim_block=0
  if grep -qF '<!-- ai-memory:start -->' "$HOME/.claude/CLAUDE.md" 2>/dev/null; then aim_block=1; fi
  if ! jq -e '.autoMemoryEnabled == false' "$HOME/.claude/settings.json" >/dev/null 2>&1; then
    if [ "$aim_block" = 1 ]; then
      python3 - "$HOME/.claude/CLAUDE.md" <<'PY'
import re, shutil, sys, time
path = sys.argv[1]
text = open(path).read()
kept = re.sub(r"\n*<!-- ai-memory:start -->.*?<!-- ai-memory:end -->\n?", "\n", text, flags=re.S)
shutil.copy2(path, f"{path}.bak-{int(time.time())}")
with open(path, "w") as f:
    f.write(kept.lstrip("\n") if kept.strip() else "")
print("  \033[0;32m✓\033[0m built-in memory is on here — removed the ai-memory routing block from ~/.claude/CLAUDE.md (backup kept)")
PY
    else
      skip "built-in memory is on here — ai-memory routing block left out (set autoMemoryEnabled false in claude/settings.$OS.json once its memories are migrated)"
    fi
  else
    "${AIM_CLI[@]}" install-instructions --target "$HOME/.claude/CLAUDE.md" --compact --no-skills
  fi
  # Probe on the host: the Docker helper cannot discover the OpenCode runtime.
  if command -v opencode &>/dev/null && opencode_version="$(opencode --version 2>/dev/null)"; then
    opencode_agent=opencode
    if [[ "$opencode_version" =~ (^|[[:space:]])v?2\. ]]; then
      opencode_agent=opencode2
    fi
    "${AIM_CLI[@]}" install-hooks --agent "$opencode_agent" --project-strategy repo-root --apply
    "${AIM_CLI[@]}" install-mcp --client "$opencode_agent" --apply
  fi
else
  warn "server not reachable — hooks and MCP not wired; re-run this script once it is up"
fi

# ── codebase-memory-mcp ───────────────────────────────────────────────────────
# The official installer verifies checksums. --skip-config: it would otherwise
# wire every agent itself — a Bash PreToolUse hook (rtk already rewrites Bash),
# three subagents and its own MCP entry. Claude Code gets the MCP entry from
# mcp-servers.json and the hooks from claude/hooks/ (below).

step "codebase-memory-mcp"
if command -v codebase-memory-mcp &>/dev/null || [ -x "$HOME/.local/bin/codebase-memory-mcp" ]; then
  skip "present ($("$HOME/.local/bin/codebase-memory-mcp" --version 2>/dev/null || codebase-memory-mcp --version 2>/dev/null)) — update with: bash ~/.local/bin/install.sh --skip-config"
else
  curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash -s -- --skip-config
  ok "installed; index a repo with: codebase-memory-mcp cli index_repository --repo-path \"\$PWD\""
fi

# Index cache and daemon rendezvous live where ai-jail can map them, so a jailed
# session and an unjailed one share ONE daemon and ONE index. The default
# rendezvous (/private/tmp on macOS, /tmp on Linux) is unreachable from the
# jail: macOS denies opening /private, and Linux gives the jail its own /tmp.
# Every CBM process must see the same pair, or it silently starts a second
# daemon: Claude gets it from settings.<OS>.json, shells from ~/.config/ai/env.sh,
# VS Code from its mcp.json entry.
CBM_ENV_JSON="$(sed -e "s|__HOME__|$HOME|g" "$AI_DIR/claude/settings.$OS.json")"
CBM_CACHE_DIR="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["env"]["CBM_CACHE_DIR"])' "$CBM_ENV_JSON")"
CBM_RUNTIME_DIR="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["env"]["CBM_RUNTIME_DIR"])' "$CBM_ENV_JSON")"
mkdir -p "$CBM_CACHE_DIR" "$CBM_RUNTIME_DIR"
chmod 700 "$(dirname "$CBM_CACHE_DIR")" "$CBM_CACHE_DIR" "$CBM_RUNTIME_DIR"

mkdir -p "$HOME/.config/ai"
env_sh="$HOME/.config/ai/env.sh"
# It also loads the worktree helpers (Worktree workflow below): zsh
# only, because sync.sh sources this file from bash, and as an `if` so a false
# test cannot trip that caller's `set -e`. Kept out of the PUBLIC ~/.zshrc.
env_body="$(printf '# Written by ai/bootstrap.sh — shared codebase-memory-mcp daemon and index.\nexport CBM_CACHE_DIR="%s"\nexport CBM_RUNTIME_DIR="%s"\n# Worktree helpers (ai/shell/devenv.zsh), zsh only.\nif [ -n "${ZSH_VERSION:-}" ] && [ -f "$HOME/.config/zsh/devenv.zsh" ]; then . "$HOME/.config/zsh/devenv.zsh"; fi\n' "$CBM_CACHE_DIR" "$CBM_RUNTIME_DIR")"
if [ -f "$env_sh" ] && [ "$(cat "$env_sh")" = "$env_body" ]; then
  skip "$env_sh up to date"
else
  printf '%s\n' "$env_body" > "$env_sh"
  ok "wrote $env_sh"
fi
# The WSL ~/.zshrc comes from the dotfiles and already sources it; on the Mac
# ~/.zshrc is local, so the line is appended once.
if grep -qF '.config/ai/env.sh' "$HOME/.zshrc" 2>/dev/null; then
  skip "~/.zshrc sources $env_sh"
else
  printf '\n# Shared AI tooling environment (dotfiles ai/bootstrap.sh)\n[ -f "$HOME/.config/ai/env.sh" ] && . "$HOME/.config/ai/env.sh"\n' >> "$HOME/.zshrc"
  ok "~/.zshrc now sources $env_sh"
fi

if [ "$OS" = Darwin ]; then
  vscode_mcp="$HOME/Library/Application Support/Code/User/mcp.json"
else
  vscode_mcp="$HOME/.config/Code/User/mcp.json"
fi
if [ -f "$vscode_mcp" ]; then
  python3 - "$vscode_mcp" "$CBM_CACHE_DIR" "$CBM_RUNTIME_DIR" <<'PY'
import json, shutil, sys, time
path, cache, runtime = sys.argv[1:4]
try:
    data = json.load(open(path))
except ValueError:
    # Empty, or JSONC with comments — VS Code accepts both; don't rewrite it.
    print(f"  · {path} is empty or not plain JSON — add the CBM env to its codebase-memory-mcp entry by hand if it has one")
    sys.exit(0)
entry = data.get("servers", {}).get("codebase-memory-mcp") if isinstance(data, dict) else None
if entry is None:
    print("  · VS Code mcp.json has no codebase-memory-mcp entry")
elif entry.get("env", {}).get("CBM_CACHE_DIR") == cache and entry["env"].get("CBM_RUNTIME_DIR") == runtime:
    print("  · VS Code mcp.json already carries the CBM env")
else:
    shutil.copy2(path, f"{path}.bak-{int(time.time())}")
    entry.setdefault("env", {}).update({"CBM_CACHE_DIR": cache, "CBM_RUNTIME_DIR": runtime})
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print("  \033[0;32m✓\033[0m VS Code mcp.json: CBM env added (backup kept)")
PY
fi

# A machine installed before --skip-config (the Mac) still carries the
# installer's own Claude Code wiring, which duplicates the hooks below and puts
# a CBM hook back on Bash: hooks that run the binary as `hook-augment`, the
# `codebase-memory` skill and the three subagents. Removed here, matched on
# that exact signature so nothing else is touched; the MCP entry is left to
# mcp-servers.json, and OpenCode / VS Code keep theirs. `codebase-memory-mcp
# install` regenerates all of it if it is ever wanted back.
# The installer wires pi the same way (2026-10-20, a bare `install.sh` run by
# accident): extensions/cbmem.ts declares its 17 tools directly next to the
# MCP entry pi already has, plus a skill. Both go too. Its block in
# ~/.pi/agent/AGENTS.md lands in this repo and shows up in `git status`.
python3 - "$HOME" <<'PY'
import json, os, shutil, sys, time
home = sys.argv[1]
removed = []

def is_installer_hook(h):
    words = h.get("command", "").split()
    return (bool(words) and os.path.basename(words[0]) == "codebase-memory-mcp"
            and "hook-augment" in words[1:] + list(h.get("args", [])))

settings = f"{home}/.claude/settings.json"
if os.path.exists(settings):
    data = json.load(open(settings))
    hooks = data.get("hooks", {})
    for event in list(hooks):
        groups, dropped = [], False
        for group in hooks[event]:
            kept = [h for h in group.get("hooks", []) if not is_installer_hook(h)]
            if len(kept) < len(group.get("hooks", [])):
                dropped = True
                removed.append(f"hook {event}[{group.get('matcher', '')}]")
            if kept:
                group["hooks"] = kept
                groups.append(group)
        if dropped:
            if groups:
                hooks[event] = groups
            else:
                del hooks[event]
    if removed:
        shutil.copy2(settings, f"{settings}.bak-{int(time.time())}")
        with open(settings, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")

for name in ("codebase-memory", "codebase-memory-scout", "codebase-memory-auditor"):
    path = f"{home}/.claude/agents/{name}.md"
    if os.path.isfile(path) and f"\nname: {name}\n" in open(path).read():
        os.remove(path)
        removed.append(f"agent {name}")
skill = f"{home}/.claude/skills/codebase-memory"
if os.path.isfile(f"{skill}/SKILL.md") and "\nname: codebase-memory\n" in open(f"{skill}/SKILL.md").read():
    shutil.rmtree(skill)
    removed.append("skill codebase-memory")

pi_ext = f"{home}/.pi/agent/extensions/cbmem.ts"
if os.path.isfile(pi_ext) and open(pi_ext).read().startswith("// codebase-memory-mcp:start\n"):
    os.remove(pi_ext)
    removed.append("pi extension cbmem.ts")
pi_skill = f"{home}/.pi/agent/skills/codebase-memory"
if os.path.isfile(f"{pi_skill}/SKILL.md") and "\nname: codebase-memory\n" in open(f"{pi_skill}/SKILL.md").read():
    shutil.rmtree(pi_skill)
    removed.append("pi skill codebase-memory")

if removed:
    print("  \033[0;32m✓\033[0m removed the installer's agent wiring: " + ", ".join(removed))
else:
    print("  · no installer-made Claude Code or pi wiring left")
PY

# Claude Code hooks from claude/hooks/, registered once and then left to the user:
#   PreToolUse (Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep)
#     block-secret-reads.py — refuses calls that would print .env, .sst/, keys or
#     tokens into the transcript (five credential leaks happened that way);
#     test_block_secret_reads.py holds its cases — run it after any edit
#   SessionStart (startup|resume|clear|compact) + PreToolUse (Grep|Glob)
#     cbm-hook-augment.sh — graph context; keeps the permanent daemon alive
#   SessionStart (startup)
#     cbm-prune-orphans.sh — deletes indexes of worktrees removed by hand
mkdir -p "$HOME/.claude/hooks"
install -m 0755 "$AI_DIR/claude/hooks/block-secret-reads.py" "$AI_DIR/claude/hooks/cbm-hook-augment.sh" \
  "$AI_DIR/claude/hooks/cbm-prune-orphans.sh" "$HOME/.claude/hooks/"
python3 - "$HOME/.claude/settings.json" "$HOME/.claude/hooks" <<'PY'
import json, os, shutil, sys, time
path, hooks_dir = sys.argv[1:3]
data = json.load(open(path)) if os.path.exists(path) else {}
hooks = data.setdefault("hooks", {})
wanted = [
    ("PreToolUse", "Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep", "block-secret-reads.py", 10),
    ("SessionStart", "startup|resume|clear|compact", "cbm-hook-augment.sh", 20),
    ("PreToolUse", "Grep|Glob", "cbm-hook-augment.sh", 20),
    ("SessionStart", "startup", "cbm-prune-orphans.sh", 60),
]
added = []
for event, matcher, script, timeout in wanted:
    groups = hooks.setdefault(event, [])
    present = any(script in h.get("command", "") for g in groups if g.get("matcher") == matcher for h in g.get("hooks", []))
    if not present:
        groups.append({"matcher": matcher, "hooks": [{"type": "command", "command": f"{hooks_dir}/{script}", "timeout": timeout}]})
        added.append(f"{event}[{matcher}] {script}")
if added:
    if os.path.exists(path):
        shutil.copy2(path, f"{path}.bak-{int(time.time())}")
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print("  \033[0;32m✓\033[0m hooks registered: " + "; ".join(added) + " (backup kept)")
else:
    print("  · Claude Code hooks already registered")
PY

# ── rtk ───────────────────────────────────────────────────────────────────────

step "rtk"
if command -v rtk &>/dev/null; then
  skip "present ($(rtk --version 2>/dev/null))"
elif [ "$OS" = Darwin ] && command -v brew &>/dev/null; then
  brew install rtk && ok "installed via brew"
else
  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
  ok "installed to ~/.local/bin"
fi
# Global hook that rewrites Bash commands through rtk, plus ~/.claude/RTK.md
# imported from ~/.claude/CLAUDE.md.
if [ -f "$HOME/.claude/RTK.md" ]; then
  skip "Claude Code hook already initialised"
else
  rtk init -g --auto-patch >/dev/null && ok "Claude Code hook initialised (rtk init -g)"
fi

# ── pi ────────────────────────────────────────────────────────────────────────
# AGENTS.md and pi/extensions/*.ts are SYMLINKED into ~/.pi/agent, so an edit
# made from a pi session lands in this repo: commit and push it and the other
# machine has it after its next sync (sync.sh pauses while it is uncommitted).
# settings.json, claude-bridge.json and auto-model.json are merged instead,
# like the Claude settings, because pi writes its own state into them
# (/auto-model policy rewrites auto-model.json). llm-mode adds the local Devstral
# entries to auto-model.json on the Mac. extensions/rtk.ts comes
# from `rtk init --agent pi`; herdr-agent-state.ts belongs to herdr.

step "pi"
if command -v pi &>/dev/null; then
  skip "present ($(pi --version 2>/dev/null)) — update with: pi update"
else
  # Run by hand, the installer asks before installing (Enter accepts); under
  # sync.sh there is no terminal and it goes ahead. Its output goes through sed
  # so it does not offer to start pi in the middle of the bootstrap.
  curl -fsSL https://pi.dev/install.sh | sh | sed 's/^/    /'
  ok "installed to ~/.pi/agent"
fi
PI="$(command -v pi || echo "$HOME/.local/bin/pi")"
bash "$AI_DIR/pi/ensure-version.sh" "$PI"
PI_DIR="$HOME/.pi/agent"
mkdir -p "$PI_DIR/extensions"

link_pi() {
  local rel="$1" src="$AI_DIR/pi/$1" dst="$PI_DIR/$1"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    skip "~/.pi/agent/$rel linked to the repo"
    return 0
  fi
  if [ -e "$dst" ] && ! cmp -s "$src" "$dst"; then
    cp -p "$dst" "$dst.bak-$(date +%s)"
    warn "~/.pi/agent/$rel differed from the repo — backup kept next to it"
  fi
  ln -sfn "$src" "$dst" && ok "linked ~/.pi/agent/$rel to the repo"
}
link_pi AGENTS.md
link_pi lib
for src in "$AI_DIR"/pi/extensions/*.ts; do
  link_pi "extensions/$(basename "$src")"
done

# pi would also install a missing package on its first start; doing it here
# keeps that start from waiting on npm or git. A git package is cloned to
# ~/.pi/agent/git/<host>/<owner>/<repo> and counts as present only at its pinned
# ref, so moving the pin here moves the checkout.
jq -r '.packages[]? | if type == "object" then .source else . end | select(startswith("npm:") or startswith("git:"))' "$AI_DIR/pi/settings.base.json" | while read -r pkg; do
  present=0
  case "$pkg" in
    npm:*)
      name="${pkg#npm:}" version=""
      case "$name" in @*/*@*|[!@]*@*) version="${name##*@}"; name="${name%@*}" ;; esac
      if [ -d "$PI_DIR/npm/node_modules/$name" ] && { [ -z "$version" ] \
          || [ "$(jq -r '.version // empty' "$PI_DIR/npm/node_modules/$name/package.json")" = "$version" ]; }; then
        present=1
      fi
      ;;
    git:*)
      repo="${pkg#git:}" ref=""
      case "$repo" in *@*) ref="${repo##*@}" repo="${repo%@*}" ;; esac
      dir="$PI_DIR/git/$repo"
      if [ -d "$dir/.git" ] && { [ -z "$ref" ] \
          || [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$(git -C "$dir" rev-parse --verify -q "$ref^{commit}" 2>/dev/null)" ]; }; then
        present=1
      fi
      ;;
  esac
  if [ "$present" = 1 ]; then
    skip "package $pkg"
  elif "$PI" install "$pkg" </dev/null >/dev/null 2>&1; then
    ok "package $pkg"
  else
    warn "could not install $pkg — run: pi install $pkg"
  fi
done

# Activate the package filters only after the pinned compatibility build succeeds.
python3 "$AI_DIR/pi/routing-compat/install.py" "$PI_DIR"
python3 "$AI_DIR/pi/apply-settings.py" "$PI_DIR" "$AI_DIR/pi"

if [ -f "$PI_DIR/extensions/rtk.ts" ]; then
  skip "rtk extension present"
else
  rtk init -g --agent pi >/dev/null && ok "rtk extension installed (rtk init -g --agent pi)"
fi

# ai-memory reaches pi through its own extension, extensions/ai-memory-pi.ts:
# lifecycle capture under pi's tool names, and its MCP tools bridged with the
# pi session id, so a call needs no workspace/project. Before it, pi had only
# Claude Code's hooks, which fire inside bridge turns and see every pi tool as
# mcp__custom-tools__*: ai-memory recorded each call as "tool unknown".
# Re-applying is idempotent (a no-op when the file is current).
if aim_server_healthy; then
  "${AIM_CLI[@]}" install-hooks --agent pi --project-strategy repo-root --apply
  # Pi loads this global file independently of Claude Code's CLAUDE.md.
  # Its skills already come from ~/.claude/skills via pi/settings.base.json.
  "${AIM_CLI[@]}" install-instructions --target "$PI_DIR/AGENTS.md" --compact --no-skills
else
  warn "ai-memory server not reachable — pi extension not written; re-run this script once it is up"
fi

# With the extension in place, ai-memory's Claude Code hooks must stay quiet
# in bridge turns, or each pi session is captured twice and the second copy
# only says "tool unknown". pi sets PI_CODING_AGENT for the Claude Code child.
# `install-hooks --agent claude-code --apply` (and `ai-memory upgrade`)
# rewrites these commands without the guard; the next run here puts it back.
if [ -f "$PI_DIR/extensions/ai-memory-pi.ts" ]; then
  python3 - "$HOME/.claude/settings.json" <<'PY'
import json, os, re, shutil, sys, time
path = sys.argv[1]
guard = '[ -n "$PI_CODING_AGENT" ] || '
data = json.load(open(path)) if os.path.exists(path) else {}
guarded = 0
for groups in data.get("hooks", {}).values():
    for group in groups:
        for hook in group.get("hooks", []):
            cmd = hook.get("command", "")
            if re.search(r"ai-memory.*(hooks/claude-code/|\bhook\b)", cmd) and not cmd.startswith(guard):
                hook["command"] = guard + cmd
                guarded += 1
if guarded:
    shutil.copy2(path, f"{path}.bak-{int(time.time())}")
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"  \033[0;32m✓\033[0m ai-memory's Claude Code hooks now skip pi's bridge turns ({guarded} guarded, backup kept)")
else:
    print("  · ai-memory's Claude Code hooks already skip pi's bridge turns")
PY
fi

# ── uv (runs the Python MCP servers through uvx) ──────────────────────────────

step "uv"
if command -v uvx &>/dev/null; then
  skip "present ($(uv --version 2>/dev/null))"
elif [ "$OS" = Darwin ] && command -v brew &>/dev/null; then
  brew install uv >/dev/null && ok "installed via brew"
else
  curl -LsSf https://astral.sh/uv/install.sh | sh && ok "installed to ~/.local/bin"
fi

# ── Playwright Chromium (for the playwright MCP entry) ────────────────────────
# Installed through the MCP package's own `playwright` dependency, so the
# browser revision always matches the pinned @playwright/mcp.

step "Playwright Chromium"
pw_pkg="$(python3 -c 'import json,sys;a=json.load(open(sys.argv[1]))["playwright"]["args"];print(next(x for x in a if x.startswith("@playwright/mcp@")))' "$AI_DIR/claude/mcp-servers.json")"
if npx -y -p "$pw_pkg" playwright install chromium >/dev/null 2>&1; then
  ok "chromium ready for $pw_pkg"
else
  warn "could not install chromium — run: npx -y -p $pw_pkg playwright install chromium"
fi

# ── Worktree workflow ─────────────────────────────────────────────────────────
# One bare-repo container per repo, one worktree + tmux window + Claude session
# per ticket. shell/devenv.zsh holds nt/nti/rv/wtmerge/wtdone and sources the
# drop-ins in ~/.config/zsh/devenv.d/; bin/git-to-bare-container converts an
# existing checkout in place. See "Worktree workflow" in README.md.

step "Worktree workflow"
mkdir -p "$HOME/.config/zsh"
if [ -f "$HOME/.config/zsh/devenv.zsh" ] && cmp -s "$AI_DIR/shell/devenv.zsh" "$HOME/.config/zsh/devenv.zsh"; then
  skip "~/.config/zsh/devenv.zsh up to date"
else
  install -m 0644 "$AI_DIR/shell/devenv.zsh" "$HOME/.config/zsh/devenv.zsh"
  ok "installed ~/.config/zsh/devenv.zsh"
fi
# Loaded through ~/.config/ai/env.sh (written in the codebase-memory step), which
# ~/.zshrc already sources — so nothing about it reaches the public .zshrc.
install -m 0755 "$AI_DIR/bin/git-to-bare-container" "$HOME/.local/bin/git-to-bare-container"

# .ai-memory.toml scopes a container's worktrees to one ai-memory project; it
# is a per-machine marker and never belongs in a commit.
git_ignore="$(git config --global core.excludesFile 2>/dev/null || true)"
git_ignore="${git_ignore/#\~/$HOME}"
[ -n "$git_ignore" ] || git_ignore="${XDG_CONFIG_HOME:-$HOME/.config}/git/ignore"
if grep -qxF '.ai-memory.toml' "$git_ignore" 2>/dev/null; then
  skip ".ai-memory.toml already in $git_ignore"
else
  mkdir -p "$(dirname "$git_ignore")"
  printf '.ai-memory.toml\n' >> "$git_ignore"
  ok "added .ai-memory.toml to $git_ignore"
fi

# tmux plugins (tpm, resurrect, continuum) for the ~/.tmux.conf in the dotfiles.
if ! command -v tmux &>/dev/null; then
  warn "tmux not installed — the worktree helpers print the path instead of opening a window"
elif [ ! -f "$HOME/.tmux.conf" ]; then
  skip "no ~/.tmux.conf (install-dotfiles.sh puts it there) — tmux plugins skipped"
else
  if [ -d "$HOME/.tmux/plugins/tpm" ]; then
    skip "tpm present"
  elif git clone --quiet --depth 1 https://github.com/tmux-plugins/tpm "$HOME/.tmux/plugins/tpm"; then
    ok "cloned tpm"
  else
    warn "could not clone tpm"
  fi
  if [ -x "$HOME/.tmux/plugins/tpm/bin/install_plugins" ]; then
    if [ -d "$HOME/.tmux/plugins/tmux-resurrect" ] && [ -d "$HOME/.tmux/plugins/tmux-continuum" ]; then
      skip "tmux plugins installed"
    else
      "$HOME/.tmux/plugins/tpm/bin/install_plugins" >/dev/null 2>&1 && ok "tmux plugins installed" \
        || warn "tmux plugins not installed — inside tmux press prefix + I"
    fi
  fi
fi

# ── herdr, lazygit and gh-dash ─────────────────────────────────────────────────
# herdr/config.toml and lazygit/config.yml are SYMLINKED, like pi's AGENTS.md,
# so an edit made from a session lands in this repo. herdr rewrites its config
# in place (checked with `config reset-keys`), so the link survives its own
# writes. Prefix + Ctrl+G opens lazygit in a herdr popup at the focused pane's
# directory; quitOnTopLevelReturn lets Esc close it. herdr comes from its
# official installer (checksum-verified, stable channel, updated with `herdr
# update`); lazygit is not installed here. gh-dash is a pinned GitHub CLI extension; Prefix + Ctrl+P opens
# the focused repository's PRs in a popup. bin/wclip copies text to the viewing
# machine's clipboard through OSC 52, which herdr forwards to a remote client.

step "herdr, lazygit and gh-dash"
link_config() {
  local src="$1" dst="$2" label="$2"
  case "$dst" in "$HOME"/*) label="~${dst#"$HOME"}" ;; esac
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    skip "$label linked to the repo"
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ] && ! cmp -s "$src" "$dst"; then
    cp -p "$dst" "$dst.bak-$(date +%s)"
    warn "$label differed from the repo — backup kept next to it"
  fi
  ln -sfn "$src" "$dst" && ok "linked $label to the repo"
}
HERDR="$(command -v herdr || echo "$HOME/.local/bin/herdr")"
if [ -x "$HERDR" ]; then
  skip "herdr present ($("$HERDR" --version 2>/dev/null))"
elif curl -fsSL https://herdr.dev/install.sh | sh >/dev/null; then
  HERDR="$HOME/.local/bin/herdr"
  ok "installed $("$HERDR" --version 2>/dev/null) to ~/.local/bin"
else
  warn "herdr not installed — run: curl -fsSL https://herdr.dev/install.sh | sh"
fi
link_config "$AI_DIR/herdr/config.toml" "$HOME/.config/herdr/config.toml"
# herdr's integrations write herdr-agent-state.* into each agent's own config
# (pi's extensions/, Claude's hooks/, OpenCode's plugins/): the agent's state in
# herdr's sidebar and native session restore. herdr owns and upgrades those
# files, so they are installed here, never linked to this repo.
if [ -x "$HERDR" ]; then
  herdr_status="$("$HERDR" integration status 2>/dev/null || true)"
  for agent in pi claude opencode; do
    case "$agent" in
      pi) [ -d "$PI_DIR/extensions" ] || continue ;;
      *) command -v "$agent" &>/dev/null || continue ;;
    esac
    if grep -q "^$agent: current" <<<"$herdr_status"; then
      skip "herdr integration $agent current"
    elif "$HERDR" integration install "$agent" >/dev/null 2>&1; then
      ok "herdr integration $agent installed"
    else
      warn "herdr integration $agent not installed — run: herdr integration install $agent"
    fi
  done
fi
# lazygit reads ~/Library/Application Support/lazygit on macOS unless
# XDG_CONFIG_HOME is set; ask it when it is installed.
if command -v lazygit &>/dev/null; then
  lazygit_dir="$(lazygit --print-config-dir)"
else
  warn "lazygit not installed — its config is linked anyway"
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then lazygit_dir="$XDG_CONFIG_HOME/lazygit"
  elif [ "$OS" = Darwin ]; then lazygit_dir="$HOME/Library/Application Support/lazygit"
  else lazygit_dir="$HOME/.config/lazygit"; fi
fi
link_config "$AI_DIR/lazygit/config.yml" "$lazygit_dir/config.yml"

if ! command -v gh &>/dev/null; then
  warn "gh not installed — install GitHub CLI and run gh auth login before using the PR popup"
elif gh dash --version &>/dev/null; then
  skip "gh-dash installed"
elif gh extension install dlvhdr/gh-dash --pin v4.26.2; then
  ok "installed gh-dash v4.26.2"
else
  warn "gh-dash not installed — run gh extension install dlvhdr/gh-dash --pin v4.26.2 after gh auth login"
fi
link_config "$AI_DIR/gh-dash/config.yml" "${XDG_CONFIG_HOME:-$HOME/.config}/gh-dash/config.yml"
link_config "$AI_DIR/bin/wclip" "$HOME/.local/bin/wclip"

# Personal lab helper is private and optional; installing it never changes trust or DNS.
if [ -f "$AI_DIR/../openbao/install.sh" ]; then
  step "OpenBao access helper"
  bash "$AI_DIR/../openbao/install.sh"
fi

# Ollama and its model are opt-in; syncing never installs or downloads them,
# closes apps, or changes the default model used by ordinary pi sessions.
if [ "$OS" = Darwin ]; then
  step "Local coding mode"
  ln -sfn "$AI_DIR/bin/llm-mode" "$HOME/.local/bin/llm-mode"
  link_config "$AI_DIR/ollama/llm-mode.json" "$HOME/.config/ai/llm-mode.json"
  if command -v ollama &>/dev/null; then
    "$HOME/.local/bin/llm-mode" configure \
      && ok "local Devstral profile configured (run llm-mode prepare for the model)" \
      || warn "local profile not updated — run llm-mode off, then llm-mode configure"
  else
    skip "llm-mode installed; opt in with brew install ollama, then llm-mode prepare"
  fi
fi

# ── ai-jail ───────────────────────────────────────────────────────────────────
# Launch with `ai-jail claude`. ~/.ai-jail is rendered from ai-jail/<OS>.toml
# unless its first line no longer carries the ai-jail-managed marker.

step "ai-jail"
if command -v ai-jail &>/dev/null; then
  skip "present ($(ai-jail --version 2>/dev/null))"
elif [ "$OS" = Darwin ]; then
  brew tap akitaonrails/tap >/dev/null
  brew trust --formula akitaonrails/tap/ai-jail >/dev/null   # this formula only, not the whole tap
  brew install ai-jail >/dev/null && ok "installed via brew"
else
  case "$ARCH" in aarch64|arm64) AJ_ASSET=ai-jail-linux-aarch64.tar.gz ;; *) AJ_ASSET=ai-jail-linux-x86_64.tar.gz ;; esac
  tmp="$(mktemp -d)"
  aj_url="https://github.com/akitaonrails/ai-jail/releases/latest/download/$AJ_ASSET"
  curl -fsSL "$aj_url" -o "$tmp/$AJ_ASSET"
  curl -fsSL "$aj_url.sha256" -o "$tmp/$AJ_ASSET.sha256"
  [ "$(sha256_of "$tmp/$AJ_ASSET")" = "$(awk 'NR==1{print $1}' "$tmp/$AJ_ASSET.sha256")" ] \
    || die "ai-jail checksum mismatch"
  tar -xzf "$tmp/$AJ_ASSET" -C "$tmp"
  install -m 0755 "$(find "$tmp" -type f -name ai-jail | head -1)" "$HOME/.local/bin/ai-jail"
  rm -rf "$tmp"
  ok "installed $("$HOME/.local/bin/ai-jail" --version) to ~/.local/bin"
fi
if [ "$OS" = Linux ] && ! command -v bwrap &>/dev/null; then
  warn "ai-jail needs bubblewrap: sudo apt install bubblewrap"
fi

jail_cfg="$HOME/.ai-jail"
if [ -f "$jail_cfg" ] && ! head -1 "$jail_cfg" | grep -q 'ai-jail-managed'; then
  skip "$jail_cfg has local edits (no ai-jail-managed marker) — left alone"
else
  claude_env="$HOME/.config/ai-jail/claude.env"
  env_line=""
  [ -f "$claude_env" ] && env_line="env_from_file = [\"$claude_env\"]"
  # Map entries for paths this machine does not have are dropped: a missing
  # map is an error to ai-jail, and installs differ (e.g. the Docker wrapper).
  rendered="$(python3 - "$AI_DIR/ai-jail/$OS.toml" "$HOME" "$env_line" <<'PY'
import os, re, sys
template, home, env_line = sys.argv[1:4]
out = []
for line in open(template).read().replace("__HOME__", home).replace("__ENV_FROM_FILE__", env_line).splitlines():
    m = re.match(r'\s*"(/[^"]+)",\s*$', line)
    if m and not os.path.exists(m.group(1)):
        continue
    out.append(line)
print("\n".join(out))
PY
)"
  if [ -f "$jail_cfg" ] && [ "$rendered" = "$(cat "$jail_cfg")" ]; then
    skip "$jail_cfg up to date"
  else
    printf '%s\n' "$rendered" > "$jail_cfg"
    ok "rendered $jail_cfg from ai-jail/$OS.toml"
  fi
  if [ "$OS" = Darwin ] && [ ! -f "$claude_env" ]; then
    warn "macOS: Claude inside the jail cannot read its login from the Keychain. Once:"
    warn "  claude setup-token, then save CLAUDE_CODE_OAUTH_TOKEN=<token> in $claude_env (chmod 600) and re-run"
  fi
fi

# ── MCP credentials ───────────────────────────────────────────────────────────
# Secrets stay in ~/.config/ai-mcp (mode 700/600), outside every repo. MCP
# entries reach them through ai-mcp-with-secrets, scoped to that one process.

step "MCP credentials"
mkdir -p "$HOME/.config/ai-mcp"
chmod 700 "$HOME/.config/ai-mcp"
install -m 0755 "$AI_DIR/mcp/with-secrets.sh" "$HOME/.local/bin/ai-mcp-with-secrets"
SECRETS="$HOME/.config/ai-mcp/secrets.env"
secrets_template="$AI_DIR/mcp/secrets.env.example"
[ -f "$AI_DIR/work/mcp/secrets.env.example" ] && secrets_template="$AI_DIR/work/mcp/secrets.env.example"
if [ -f "$SECRETS" ]; then
  skip "$SECRETS exists"
else
  install -m 0600 "$secrets_template" "$SECRETS"
  ok "created $SECRETS from the template — fill in read-only credentials"
fi

# The private overlay (absent from the public repo): AWS session script, DBHub
# configs and the prod DB shell helpers. Its MCP servers join the step below.
if [ -f "$AI_DIR/work/bootstrap.sh" ]; then
  # shellcheck source=/dev/null
  . "$AI_DIR/work/bootstrap.sh"
fi

# ── TypeScript language server (for the typescript-lsp plugin) ────────────────

step "typescript-language-server"
if command -v typescript-language-server &>/dev/null; then
  skip "present"
elif command -v npm &>/dev/null; then
  npm install -g typescript-language-server typescript >/dev/null
  ok "installed globally for node $(node --version)"
else
  warn "npm not on PATH — install it, then: npm i -g typescript-language-server typescript"
fi

# ── Claude Code plugin marketplaces ───────────────────────────────────────────

step "Claude Code plugin marketplaces"
known_marketplaces="$(claude plugin marketplace list --json 2>/dev/null || echo '[]')"
grep -vE '^\s*(#|$)' "$AI_DIR/claude/marketplaces.txt" | while read -r repo; do
  if grep -qF "\"$repo\"" <<<"$known_marketplaces"; then
    skip "$repo"
  else
    claude plugin marketplace add "$repo" >/dev/null && ok "$repo"
  fi
done

# ── Claude Code plugins ───────────────────────────────────────────────────────

step "Claude Code plugins"
installed="$(claude plugin list --json 2>/dev/null || echo '[]')"
grep -vE '^\s*(#|$)' "$AI_DIR/claude/plugins.txt" | while read -r plugin; do
  case "$plugin" in
    -*)
      plugin="${plugin#-}"
      if grep -qF "\"$plugin\"" <<<"$installed"; then
        claude plugin uninstall "$plugin" --scope user >/dev/null && ok "removed $plugin"
      fi
      ;;
    *)
      if grep -qF "\"$plugin\"" <<<"$installed"; then
        skip "$plugin"
      else
        claude plugin install "$plugin" --scope user >/dev/null && ok "$plugin"
      fi
      ;;
  esac
done

# ── MCP servers (user scope) ──────────────────────────────────────────────────

# claude/mcp-servers.json, then work/mcp-servers.json when the private overlay
# is present. Keys starting with "_" gate an entry and are stripped before registering:
#   _only_os       register only on this `uname -s`
#   _requires_env  variables that must be non-empty in secrets.env
#   _check         shell command that must succeed (e.g. a login exists)
# A NEW entry whose gate fails is reported as pending, never registered
# half-set. An EXISTING user-scope entry with the same name but a different
# definition is replaced: this file is the source of truth, and the difference
# is usually a safety flag (`--readonly`) the hand-made entry lacks.

step "MCP servers"
python3 - "$SECRETS" "$OS" "$HOME" "$HOME/.claude.json" "$AI_DIR/claude/mcp-servers.json" "$AI_DIR/work/mcp-servers.json" <<'PY' |
import json, os, re, sys
secrets_path, os_name, home, claude_json = sys.argv[1:5]
server_files = [p for p in sys.argv[5:] if os.path.exists(p)]
secrets = {}
for line in open(secrets_path):
    m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)", line)
    if m:
        secrets[m.group(1)] = m.group(2).strip().strip("'\"")
current = json.load(open(claude_json)).get("mcpServers", {}) if os.path.exists(claude_json) else {}

def normal(cfg):
    cfg = {k: v for k, v in cfg.items() if not k.startswith("_") and v not in ({}, [], None)}
    if "command" in cfg:
        cfg.setdefault("type", "stdio")
    return cfg

wanted = {}
for path in server_files:
    wanted.update(json.load(open(path)))
for name, cfg in wanted.items():
    only_os = cfg.get("_only_os")
    if only_os and only_os != os_name:
        continue
    clean = json.loads(json.dumps(normal(cfg)).replace("__HOME__", home))
    if name not in current:
        state = "absent"
    elif normal(current[name]) == clean:
        state = "same"
    else:
        state = "differs"
    missing = [v for v in cfg.get("_requires_env", []) if not secrets.get(v)]
    print("\x1f".join([name, state, ",".join(missing), cfg.get("_check", ""), json.dumps(clean)]))
PY
while IFS=$'\x1f' read -r name state missing check cfg; do
  case "$state" in
    same)
      skip "$name" ;;
    differs)
      claude mcp remove --scope user "$name" >/dev/null 2>&1
      claude mcp add-json --scope user "$name" "$cfg" >/dev/null && ok "$name updated to match mcp-servers.json" ;;
    absent)
      if [ -n "$missing" ]; then
        warn "$name pending — set $missing in $SECRETS"
      elif [ -n "$check" ] && ! bash -c "$check" </dev/null; then
        warn "$name pending — prerequisite not met: $check"
      else
        claude mcp add-json --scope user "$name" "$cfg" >/dev/null && ok "$name"
      fi ;;
  esac
done

# ── pi MCP servers ────────────────────────────────────────────────────────────
# pi reads Claude Code's mcpServers format as is, so it gets exactly the
# user-scope servers this machine's Claude Code has after the step above: the
# gates and __HOME__ come along. A same-name entry follows Claude's; a server
# added to pi alone stays. ai-memory is the exception: where its pi extension
# exists (pi step) it already bridges the tools, session-aware, and a second
# copy over MCP would offer all 23 of them twice. pi/mcp.json adds the servers
# Claude Code gets from a plugin (stark), which ~/.claude.json does not list.

step "pi MCP servers"
python3 - "$HOME/.claude.json" "$HOME/.pi/agent/mcp.json" "$HOME/.pi/agent/extensions/ai-memory-pi.ts" "$AI_DIR/pi/mcp.json" <<'PY'
import json, os, shutil, sys, time
claude_json, pi_mcp, aim_ext, pi_layer = sys.argv[1:5]
servers = json.load(open(claude_json)).get("mcpServers", {}) if os.path.exists(claude_json) else {}
current = json.load(open(pi_mcp)) if os.path.exists(pi_mcp) else {}
merged = json.loads(json.dumps(current))
merged.setdefault("mcpServers", {}).update(servers)
merged["mcpServers"].update(json.load(open(pi_layer)).get("mcpServers", {}))
if os.path.exists(aim_ext):
    merged["mcpServers"].pop("ai-memory", None)
if merged == current:
    print("  · ~/.pi/agent/mcp.json already has Claude Code's MCP servers")
else:
    if os.path.exists(pi_mcp):
        shutil.copy2(pi_mcp, f"{pi_mcp}.bak-{int(time.time())}")
    os.makedirs(os.path.dirname(pi_mcp), exist_ok=True)
    with os.fdopen(os.open(pi_mcp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(merged, f, indent=2)
        f.write("\n")
    print("  \033[0;32m✓\033[0m copied Claude Code's MCP servers into ~/.pi/agent/mcp.json (backup kept)")
PY

# Every step above succeeded (set -e), so this commit counts as applied and
# sync.sh will not re-run it. Recorded BEFORE the scheduler loads: its
# RunAtLoad run would otherwise start a second bootstrap alongside this one.
"$AI_DIR/sync.sh" --mark-applied

# ── dotfiles auto-sync ────────────────────────────────────────────────────────
# ai/sync.sh every 15 minutes: fast-forwards this clone and re-runs this script
# when ai/ changed. Left alone when sync.sh is the caller — reloading the
# LaunchAgent would kill the very run executing it — so a change to the
# schedule itself takes effect on the next manual run.

step "dotfiles auto-sync"
# It runs whatever reaches the branch, unattended: on by default only in the
# owner's private clone, opt-in (DOTFILES_AUTO_SYNC=1) in a public one.
origin_url="$(git -C "$AI_DIR/.." remote get-url origin 2>/dev/null || true)"
case "$origin_url" in
  *[/:]dnl1/.dotfiles|*[/:]dnl1/.dotfiles.git) own_clone=1 ;;
  *) own_clone=0 ;;
esac
if [ "${DOTFILES_SYNC:-}" = 1 ]; then
  skip "running under sync.sh — scheduler left as is"
elif [ "$own_clone" = 0 ] && [ "${DOTFILES_AUTO_SYNC:-}" != 1 ]; then
  skip "not the private dnl1/.dotfiles clone — auto-sync off (re-run with DOTFILES_AUTO_SYNC=1 to schedule it)"
elif [ "$OS" = Darwin ]; then
  label=com.dnl1.dotfiles-sync
  plist="$HOME/Library/LaunchAgents/$label.plist"
  sync_log="$HOME/Library/Logs/dotfiles-sync.log"
  rendered="$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$AI_DIR/sync.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$sync_log</string>
  <key>StandardErrorPath</key>
  <string>$sync_log</string>
</dict>
</plist>
PLIST
)"
  if [ -f "$plist" ] && [ "$(cat "$plist")" = "$rendered" ] && launchctl print "gui/$(id -u)/$label" &>/dev/null; then
    skip "LaunchAgent loaded and up to date"
  else
    mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$sync_log")"
    printf '%s\n' "$rendered" > "$plist"
    launchctl bootout "gui/$(id -u)/$label" &>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    ok "LaunchAgent loaded — every 15 min, log: $sync_log"
  fi
elif systemctl --user show-environment &>/dev/null; then
  unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"
  service_body="[Unit]
Description=Fast-forward dnl1/.dotfiles and re-apply ai/bootstrap.sh when ai/ changed
After=network-online.target

[Service]
Type=oneshot
ExecStart=$AI_DIR/sync.sh
Nice=10
TimeoutStartSec=30min"
  # OnUnitInactiveSec counts from the end of the previous run, so runs never
  # overlap; OnStartupSec catches up when WSL starts.
  timer_body="[Unit]
Description=Check dnl1/.dotfiles for new commits every 15 minutes

[Timer]
OnStartupSec=2min
OnUnitInactiveSec=15min
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target"
  units_changed=0
  write_unit() {
    if [ ! -f "$1" ] || [ "$(cat "$1")" != "$2" ]; then
      printf '%s\n' "$2" > "$1"
      units_changed=1
    fi
  }
  write_unit "$unit_dir/dotfiles-sync.service" "$service_body"
  write_unit "$unit_dir/dotfiles-sync.timer" "$timer_body"
  [ "$units_changed" = 1 ] && systemctl --user daemon-reload
  if systemctl --user enable --now dotfiles-sync.timer >/dev/null 2>&1; then
    if [ "$units_changed" = 1 ]; then
      ok "systemd timer enabled — every 15 min, log: ${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles-sync/sync.log"
    else
      skip "systemd timer enabled and up to date"
    fi
  else
    warn "could not enable dotfiles-sync.timer — see: systemctl --user status dotfiles-sync.timer"
  fi
else
  warn "systemd is not running — no auto-sync; run ai/sync.sh by hand after pushing from the other machine"
fi

echo -e "\n${GREEN}${BOLD}Done.${RESET} Restart open Claude Code / OpenCode / pi sessions to pick up the changes."
