#!/usr/bin/env bash
set -euo pipefail
PI="$1"
version_ok() {
  python3 - "$("$PI" --version)" <<'PY'
import re, sys
version = re.fullmatch(r"\s*(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?\s*", sys.argv[1])
sys.exit(0 if version and tuple(map(int, version.groups())) >= (1, 4, 0) else 1)
PY
}
if ! version_ok; then
  "$PI" update </dev/null
  version_ok || { echo 'Pi 1.4.0 or later is required; update Pi with its package manager.' >&2; exit 1; }
fi
