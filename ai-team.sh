#!/usr/bin/env zsh
# ai-team — tmux session with N opencode agents + 1 monitor pane
#
# Usage:
#   ai-team [action] [N] ["prompt"]
#
# action: attach (default) | reset | recreate | hydrate-monitor
# N:      number of agents, 1-3 (default: 1)
# prompt: optional seed text pasted into each agent on session creation
#
# Examples:
#   ai-team              # 1 agent + monitor, attach or create
#   ai-team 2            # 2 agents + monitor
#   ai-team 3 "add auth" # 3 agents, seeded with prompt
#   ai-team reset        # kill and recreate with same N
#   ai-team reset 2      # kill and recreate with 2 agents

set -euo pipefail

SESSION="ai-team"
LAYOUT_VERSION="v5"
PROJECT_DIR="$PWD"

AGENT_ROLES=(dev review wildcard)
AGENT_PROMPTS=(
  "You are a senior backend engineer.\nTask:\n- Implement the requested feature\n- Keep code clean and minimal\n- Follow existing patterns"
  "You are a strict code reviewer.\nTask:\n- Review changes critically\n- Suggest improvements\n- Identify bugs and edge cases"
  "You are a problem solver agent.\nTask:\n- Fix failing tests\n- Optimize performance\n- Debug issues\n- Do whatever is needed to move forward"
)

# ── Arg parsing ───────────────────────────────────────────────────────────────

is_action() {
  case "$1" in attach|reset|recreate|hydrate-monitor) return 0 ;; *) return 1 ;; esac
}

ACTION="attach"
N_AGENTS=1

if [[ $# -gt 0 ]] && is_action "$1"; then
  ACTION="$1"
  shift
fi

if [[ $# -gt 0 && "$1" =~ ^[1-3]$ ]]; then
  N_AGENTS="$1"
  shift
fi

USER_PROMPT="$*"

MONITOR_IDX=$N_AGENTS   # monitor is always last pane

# ── Helpers ───────────────────────────────────────────────────────────────────

session_exists()         { tmux has-session -t "$SESSION" 2>/dev/null }
current_layout_version() { tmux show-options -qv -t "$SESSION" @ai_team_layout_version 2>/dev/null }
current_n_agents()       { tmux show-options -qv -t "$SESSION" @ai_team_n_agents 2>/dev/null || echo "1" }

build_pane_border_format() {
  local result=" monitor "
  for i in $(seq $((N_AGENTS - 1)) -1 0); do
    local role="${AGENT_ROLES[$((i + 1))]}"  # zsh arrays are 1-indexed
    result="#{?#{==:#{pane_index},$i}, ${role} ,${result}}"
  done
  echo "$result"
}

build_agent_prompt() {
  local idx="$1"   # 0-indexed
  local base="${AGENT_PROMPTS[$((idx + 1))]}"
  if [[ -n "$USER_PROMPT" ]]; then
    printf "%b\n\nUser request:\n%s" "$base" "$USER_PROMPT"
  else
    printf "%b" "$base"
  fi
}

start_agent_pane() {
  local target="$1"
  tmux send-keys -t "$target" "clear" C-m
  tmux send-keys -t "$target" "opencode \"$PROJECT_DIR\"" C-m
}

prefill_agent_pane() {
  local target="$1"
  local idx="$2"
  tmux set-buffer -- "$(build_agent_prompt "$idx")"
  tmux paste-buffer -t "$target"
}

hydrate_monitor_pane() {
  if ! session_exists; then return 0; fi
  if [[ "$(tmux show-options -qv -t "$SESSION" @ai_team_monitor_bootstrapped 2>/dev/null)" == "1" ]]; then
    return 0
  fi
  local n="$(tmux show-options -qv -t "$SESSION" @ai_team_n_agents 2>/dev/null || echo 1)"
  tmux respawn-pane -k -t "$SESSION:0.$n" "${SHELL:-/bin/zsh} -il"
  tmux select-pane  -t "$SESSION:0.$n" -T 'monitor'
  tmux set-option   -t "$SESSION" @ai_team_monitor_bootstrapped 1
  tmux set-hook -u  -t "$SESSION" client-attached
}

create_session() {
  tmux new-session -d -s "$SESSION"
  tmux rename-window -t "$SESSION:0" 'team'

  tmux set-option -t "$SESSION" pane-border-status top
  tmux set-option -t "$SESSION" pane-border-format "$(build_pane_border_format)"
  tmux set-option -t "$SESSION" status-left "[ai-team:${N_AGENTS}+mon] "
  tmux set-option -t "$SESSION" @ai_team_layout_version "$LAYOUT_VERSION"
  tmux set-option -t "$SESSION" @ai_team_n_agents "$N_AGENTS"
  tmux set-option -t "$SESSION" @ai_team_monitor_bootstrapped 0
  tmux set-hook   -t "$SESSION" client-attached \
    "run-shell '$HOME/.dotfiles/ai-team.sh hydrate-monitor'"

  # Create additional panes (start with 1, add N_AGENTS more for monitor)
  local total=$((N_AGENTS + 1))
  for i in $(seq 1 $((total - 1))); do
    tmux split-window -t "$SESSION:0"
  done
  tmux select-layout -t "$SESSION:0" tiled

  # Configure agent panes
  for i in $(seq 0 $((N_AGENTS - 1))); do
    local role="${AGENT_ROLES[$((i + 1))]}"
    tmux select-pane -t "$SESSION:0.$i" -T "$role"
    start_agent_pane "$SESSION:0.$i"
  done

  # Configure monitor pane
  tmux select-pane -t "$SESSION:0.$MONITOR_IDX" -T 'monitor'
  tmux send-keys   -t "$SESSION:0.$MONITOR_IDX" "clear" C-m

  # Seed agent prompts after opencode has had a moment to start
  sleep 1
  for i in $(seq 0 $((N_AGENTS - 1))); do
    prefill_agent_pane "$SESSION:0.$i" "$i"
  done

  tmux select-pane -t "$SESSION:0.0"
}

# ── Main ──────────────────────────────────────────────────────────────────────

if [[ "$ACTION" == "hydrate-monitor" ]]; then
  hydrate_monitor_pane
  exit 0
fi

should_recreate=false

if [[ "$ACTION" == "reset" || "$ACTION" == "recreate" ]]; then
  should_recreate=true
elif [[ -n "$USER_PROMPT" ]]; then
  should_recreate=true
elif session_exists && [[ "$(current_layout_version)" != "$LAYOUT_VERSION" ]]; then
  should_recreate=true
elif session_exists && [[ "$(current_n_agents)" != "$N_AGENTS" ]]; then
  should_recreate=true
fi

if session_exists && [[ "$should_recreate" == true ]]; then
  tmux kill-session -t "$SESSION"
fi

if ! session_exists; then
  create_session
fi

tmux attach -t "$SESSION"
