#!/usr/bin/env python3
"""PreToolUse hook: refuse tool calls that would put a secret into the transcript.

Five credential leaks happened the same way: a shell text tool (grep, cat, sed,
even `grep -c` behind rtk's preview) run against .env or .sst/ to "just check"
a value. Instructions did not stop it; this hook does.

Blocked
  Read / Edit / Write / MultiEdit / NotebookEdit / Grep on a protected path.
  Bash commands where a reading or copying program meets a protected path, and
  commands that dump environment variables (printenv, bare env, echo $…TOKEN,
  /proc/*/environ).
Allowed
  Using a secret without reading it: `tsx --env-file=.env`, `DOTENV_CONFIG_PATH=…`,
  `source .env` (prints nothing), `ls`/`test -f`/`git check-ignore` on the path,
  `.env.example`. Presence checks: node -e "console.log(process.env.X ? 'set' : 'unset')".
Known gap
  Heredoc bodies are treated as data (scripts that merely MENTION .env in prose
  would otherwise be refused), so a heredoc script that opens .env is not caught.

Fails open on its own bugs (a broken guard must not wedge every tool call), but
a payload it cannot parse that names a protected path is refused.
"""
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
SAFE_ENV_SUFFIXES = {"example", "sample", "template", "dist"}
SSH_PUBLIC = {"config", "known_hosts", "known_hosts.old", "authorized_keys"}

# ---------------------------------------------------------------- paths

def protected_path(raw, cwd):
    """Reason string when RAW (as a tool would resolve it) is protected, else None."""
    if not raw:
        return None
    p = os.path.normpath(os.path.join(cwd or HOME, os.path.expanduser(raw)))
    base = os.path.basename(p)
    parts = p.split(os.sep)
    if base == ".env" or (base.startswith(".env.") and base[5:].split(".")[0] not in SAFE_ENV_SUFFIXES):
        return f"{base} holds credentials"
    if ".sst" in parts:
        return ".sst/ holds the deployed environment (it leaked the staging DB URL once)"
    if base == "eventlog.json":
        return "Pulumi event logs carry the Lambda environment"
    if ".dotenvs" in parts:
        return ".dotenvs/ holds credentials"
    under = lambda d: p == d or p.startswith(d + os.sep)
    if under(f"{HOME}/.config/secrets"):
        return "~/.config/secrets holds credentials"
    if under(f"{HOME}/.config/ai-mcp/aws") or p == f"{HOME}/.config/ai-mcp/secrets.env":
        return "MCP credentials"
    if p in (f"{HOME}/.aws/credentials", f"{HOME}/.config/gh/hosts.yml",
             f"{HOME}/.claude/.credentials.json", f"{HOME}/.config/ai-jail/claude.env"):
        return "a credential store"
    if under(f"{HOME}/.ssh") and p != f"{HOME}/.ssh" and not base.endswith(".pub") and base not in SSH_PUBLIC:
        return "an SSH private key"
    if p.startswith("/dev/shm/dbcreds."):
        return "the decrypted DB credential store"
    if p.startswith("/proc/") and base == "environ":
        return "a process environment"
    return None

# ---------------------------------------------------------------- bash

# `\.env` (escaped dot) is a regex in a search pattern such as process\.env\.X,
# never a shell path, so a preceding backslash does not count.
ENV_TOKEN = r"(?<![\w.$/\\-])(?:[\w./~-]*/)?\.env(?:\.(?!(?:example|sample|template|dist)\b)[\w-]+)*(?![\w.-])"
SENSITIVE_IN_COMMAND = re.compile(
    ENV_TOKEN
    + r"|\.sst(?:/|\b)|eventlog\.json|\.dotenvs\b|\.config/secrets\b|secrets\.env\b|ai-mcp/aws\b"
    + r"|\.aws/credentials\b|gh/hosts\.yml\b|\.credentials\.json\b|ai-jail/claude\.env\b"
    + r"|/dev/shm/dbcreds|\.ssh/id_[\w-]+(?!\.pub)\b|/proc/[^\s/]+/environ\b"
)
# Ways to USE a secret file without reading it into the output.
EXEMPT = re.compile(
    r"--env-file(?:=|\s+)\S+|DOTENV_CONFIG_PATH=\S+|\bdotenv\s+(?:-e|--file)\s+\S+"
    r"|(?:^|[;&|(]\s*)(?:source|\.)\s+\S+"
)
READERS = re.compile(
    r"(?<![\w.-])(?:cat|bat|batcat|less|more|head|tail|grep|egrep|fgrep|zgrep|rg|ag|ack|sed|awk|gawk|mawk|perl"
    r"|cut|strings|xxd|od|hexdump|base64|jq|yq|sort|uniq|diff|cmp|tee|nl|tac|rev|paste|column|tr|fold"
    r"|vi|vim|nvim|nano|cp|mv|scp|rsync|curl|wget|nc|zip|tar|gzip|7z|python|python3|node|ruby|php|rtk"
    r"|xargs|iconv|dd|clip\.exe)(?![\w.-])"
)
ENV_DUMP = re.compile(
    r"(?<![\w.-])printenv(?![\w.-])"
    r"|(?:^|[;&|(]|\$\()\s*env\s*(?:$|[;&|)>])"
    r"|(?:^|[;&|(])\s*(?:export\s+-p|declare\s+-[xp]|typeset\s+-x|set)\s*(?:$|[;&|)>])"
    r"|(?:echo|printf|print)\b[^;&|\n]*\$\{?\w*(?:TOKEN|SECRET|PASSW|API_?KEY|PRIVATE|DATABASE_URL|_DSN|CREDENTIAL)"
)
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n(.*?)\n\s*\2\s*(?:\n|$)", re.S)


def strip_heredocs(cmd):
    """Keep each heredoc's opening line, drop its body (data, not commands)."""
    return HEREDOC.sub(lambda m: m.group(0).split("\n", 1)[0] + "\n", cmd)


def bash_reason(cmd):
    shell = strip_heredocs(cmd)
    if ENV_DUMP.search(shell):
        return "it would print environment variables, which carry tokens"
    scan = EXEMPT.sub(" ", shell)
    if not SENSITIVE_IN_COMMAND.search(scan):
        return None
    if READERS.search(scan) or re.search(r"<\s*['\"]?[^\s;&|]*(?:\.env|environ|secrets)", scan):
        return "it reads or copies a credential file"
    return None

# ---------------------------------------------------------------- main

def deny(reason):
    msg = (f"Blocked by ~/.claude/hooks/block-secret-reads.py: {reason}. Its contents would land in the "
           "transcript. Use the secret without reading it (tsx --env-file=.env, DOTENV_CONFIG_PATH=…, withdb), "
           "check presence with node -e \"console.log(process.env.X ? 'set' : 'unset')\", or ask the user to run "
           "it in their own terminal.")
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                             "permissionDecision": "deny",
                                             "permissionDecisionReason": msg}}))
    sys.exit(0)


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except ValueError:
        if SENSITIVE_IN_COMMAND.search(raw):
            deny("unparseable hook payload naming a protected path")
        return
    tool = data.get("tool_name", "")
    inp = data.get("tool_input") or {}
    cwd = data.get("cwd") or os.getcwd()

    if tool == "Bash":
        reason = bash_reason(inp.get("command", ""))
        if reason:
            deny(reason)
        return
    for key in ("file_path", "notebook_path", "path"):
        reason = protected_path(inp.get(key), cwd)
        if reason:
            deny(f"{inp.get(key)} is protected ({reason})")
    if tool == "Grep":
        g = inp.get("glob") or ""
        if re.search(r"(^|/|\{|,)\.env(\*|$|\.(?!example|sample|template|dist)|[},])|\.sst|eventlog", g):
            deny(f"glob {g!r} selects protected files")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:  # a broken guard must not wedge every tool call
        sys.exit(0)
