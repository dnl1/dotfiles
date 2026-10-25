#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d test/fixtures/context-paging ]; then
  mkdir -p test/fixtures
  cp -R ../../npm/node_modules/@rochecompaan/pi-context-paging test/fixtures/context-paging
fi
tests=(./test/compat.test.ts ./test/history-replay.test.ts ./test/paging.test.ts)
for file in vendor/pi-codex-native/test/*.test.ts; do
  case "$file" in
    */context-recovery.test.ts|*/hybrid-session.test.ts|*/developer-messages.test.ts) continue ;;
  esac
  tests+=("./$file")
done
bun test --only-failures "${tests[@]}" --test-name-pattern '^(?!executes the local Rust)'
bun ./test/sdk-smoke.ts
