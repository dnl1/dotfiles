#!/usr/bin/env bash
# Runs one MCP server with the credentials in ~/.config/ai-mcp/secrets.env, so
# they reach that process instead of every shell. Installed by bootstrap.sh as
# ~/.local/bin/ai-mcp-with-secrets; MCP entries call it as their command.

set -euo pipefail

secrets="${AI_MCP_SECRETS:-$HOME/.config/ai-mcp/secrets.env}"
[ -f "$secrets" ] || { echo "ai-mcp-with-secrets: $secrets not found" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) mode="$(stat -f %Lp "$secrets")" ;;
  *) mode="$(stat -c %a "$secrets")" ;;
esac
case "$mode" in
  600|400) ;;
  *) echo "ai-mcp-with-secrets: $secrets is mode $mode; run: chmod 600 \"$secrets\"" >&2; exit 1 ;;
esac

set -a
# shellcheck source=/dev/null
. "$secrets"
set +a
exec "$@"
