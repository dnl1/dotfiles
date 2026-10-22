#!/usr/bin/env bash
# SessionStart / PreToolUse(Grep|Glob) hook: codebase-memory graph context.
#
# hook-augment only answers through the PERMANENT daemon (an MCP session's
# internal daemon does not count). With none running it prints a "no CBM
# daemon" systemMessage once, then nothing, and never any context. So: when the
# daemon's socket does not accept a connection, start the daemon detached and
# stay silent — the first session after a restart goes without context once.
#
# Liveness = connecting to the daemon socket under CBM_RUNTIME_DIR (shared with
# ai-jail by ai/bootstrap.sh). Not pgrep: the jail cannot see host processes,
# and `pgrep -f` also matches any shell whose command line contains the pattern.
# Not hook-augment's own warning: it is printed once and then suppressed.
# Fail-open: never blocks or fails the tool call.
BIN="$HOME/.local/bin/codebase-memory-mcp"
[ -x "$BIN" ] || { cat >/dev/null; exit 0; }

daemon_up() {
  python3 - "${CBM_RUNTIME_DIR:-/tmp}/cbm-daemon-$(id -u)" <<'PY' 2>/dev/null
import glob, os, socket, sys
for path in glob.glob(os.path.join(sys.argv[1], "cbm-*.sock")):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(0.3)
    try:
        s.connect(path)
        sys.exit(0)
    except OSError:
        pass
    finally:
        s.close()
sys.exit(1)
PY
}

if ! daemon_up; then
  cat >/dev/null
  if command -v setsid >/dev/null; then
    setsid -f "$BIN" daemon start >/dev/null 2>&1 </dev/null
  else
    (nohup "$BIN" daemon start >/dev/null 2>&1 </dev/null &)
  fi
  exit 0
fi
CBM_LOG_LEVEL=error "$BIN" hook-augment 2>/dev/null
exit 0
