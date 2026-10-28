#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PI_SESSION_FILE:?Set PI_SESSION_FILE to the captured session JSONL}"
tests=(./test/compat.test.ts ./test/history-replay.test.ts)
for file in vendor/pi-codex-native/test/*.test.ts; do
  case "$file" in
    */context-recovery.test.ts|*/hybrid-session.test.ts|*/developer-messages.test.ts) continue ;;
  esac
  tests+=("./$file")
done
bun test --only-failures "${tests[@]}" --test-name-pattern '^(?!executes the local Rust)'
bun ./test/sdk-smoke.ts
