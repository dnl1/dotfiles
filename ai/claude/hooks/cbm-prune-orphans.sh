#!/usr/bin/env bash
# SessionStart (startup) hook: deletes codebase-memory indexes whose project
# directory no longer exists — worktrees removed without `wtdone`.
#
# A path whose nearest surviving parent is less than 3 levels deep is skipped:
# that looks like an unmounted drive, not a deleted worktree. Prints nothing on
# stdout (SessionStart stdout is injected into Claude's context); everything goes
# to prune.log. Fail-open: always exits 0, never blocks the session.
set -u
BIN="$HOME/.local/bin/codebase-memory-mcp"
LOG="${CBM_CACHE_DIR:-$HOME/.cache/codebase-memory-mcp}/prune.log"
[ -x "$BIN" ] && command -v jq >/dev/null || exit 0

# `timeout` is GNU coreutils; macOS may not have it.
t() { if command -v timeout >/dev/null; then timeout "$@"; else shift; "$@"; fi; }
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG" 2>/dev/null; }

# JSON, not the default tree view: the tree compresses shared path prefixes
# into "@0+suffix" references, which a column parser silently misreads.
listing=$(CBM_LOG_LEVEL=error t 20 "$BIN" cli --quiet list_projects --format json --limit 1000 2>/dev/null \
  | jq -r '.projects[] | [.name, .root_path] | @tsv' 2>/dev/null) || exit 0

printf '%s\n' "$listing" | while IFS=$'\t' read -r name root; do
  case "$root" in /*) ;; *) continue ;; esac
  [ -e "$root" ] && continue

  parent=$(dirname "$root")
  while [ ! -e "$parent" ]; do parent=$(dirname "$parent"); done
  depth=$(printf '%s' "$parent" | tr -cd '/' | wc -c)
  if [ "$parent" = "/" ] || [ "$depth" -lt 3 ]; then
    log "skip $name: $root missing, nearest parent $parent is too shallow (unmounted drive?)"
    continue
  fi

  if CBM_LOG_LEVEL=error t 30 "$BIN" cli --quiet delete_project --project "$name" >/dev/null 2>&1; then
    log "deleted $name: $root no longer exists"
  else
    log "failed to delete $name ($root)"
  fi
done
exit 0
