"""Cases for block-secret-reads.py — run after any edit: python3 ai/claude/hooks/test_block_secret_reads.py

The first five are the commands that actually leaked credentials; the "allow"
cases are real day-to-day commands that must keep working.
"""
import json, os, subprocess, sys

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "block-secret-reads.py")
H = os.path.expanduser("~")
CWD = f"{H}/work/app/main"
B, A = "deny", "allow"

def bash(cmd): return ("Bash", {"command": cmd})
def read(p): return ("Read", {"file_path": p})

CASES = [
    # --- the five real leaks (memory: never grep .env) ---
    (B, bash("rtk grep -c '^DATABASE_URL_PROD=\"' .env")),
    (B, bash("grep DATABASE_URL_STAGE .env | sed -E 's#//([^:]+):[^@]+@#//\\1:***@#'")),
    (B, bash(f"cat {H}/work/repos/app/.env | grep STAGE")),
    (B, bash('grep -c "^DATABASE_URL_STAGE=" .env')),
    (B, bash("rtk grep -rn DATABASE_URL --include='*.json' .sst/")),
    # --- other reads of protected files ---
    (B, bash("cat .env.local")),
    (B, bash("head -3 ../main/.env.production")),
    (B, bash("jq . .sst/pulumi/abc/eventlog.json")),
    (B, bash("find . -name eventlog.json -exec cat {} \\;")),
    (B, bash("while read l; do echo $l; done < .env")),
    (B, bash("cp .env /tmp/x")),
    (B, bash("tar czf /tmp/e.tgz .env")),
    (B, bash("python3 -c \"print(open('.env').read())\"")),
    (B, bash("cat ~/.config/gh/hosts.yml")),
    (B, bash("cat ~/.config/secrets/github.env")),
    (B, bash("tr '\\0' '\\n' < /proc/1234/environ")),
    (B, bash("cat ~/.ssh/id_ed25519")),
    (B, bash("source .env && echo $DATABASE_URL")),
    (B, bash("printenv")),
    (B, bash("env | grep -i token")),
    (B, bash("echo $GITHUB_PERSONAL_ACCESS_TOKEN")),
    (B, bash("set | grep AWS")),
    (B, read(f"{H}/work/app/main/.env")),
    (B, read(".env.local")),
    (B, read("~/.ssh/id_ed25519")),
    (B, read(f"{H}/.config/secrets/github.env")),
    (B, read(f"{H}/.aws/credentials")),
    (B, ("Edit", {"file_path": ".env", "old_string": "a", "new_string": "b"})),
    (B, ("Write", {"file_path": f"{H}/work/app/main/.env", "content": "X=1"})),
    (B, ("Grep", {"pattern": "DATABASE_URL", "path": ".env"})),
    (B, ("Grep", {"pattern": "x", "path": f"{H}/work/app/main/.sst"})),
    (B, ("Grep", {"pattern": "DATABASE_URL", "glob": ".env*"})),
    # --- legitimate uses: must pass ---
    (A, bash(f"DOTENV_CONFIG_PATH={H}/work/app/main/.env pnpm tsx scripts/x.ts --prod")),
    (A, bash("pnpm tsx --env-file=.env scripts/x.ts")),
    (A, bash("node --env-file .env scripts/x.js")),
    (A, bash("set -a; source .env; set +a; pnpm dev")),
    (A, bash("ls -la .env* && git check-ignore -v .env")),
    (A, bash("test -f .env && echo present")),
    (A, bash("cat .env.example")),
    (A, bash("grep -rn 'process.env.DATABASE_URL' lib/ | head")),
    (A, bash("rg 'import.meta.env' app")),
    (A, bash("git grep -ohE 'process\\.env\\.[A-Z_]+' -- src | sort -u")),
    (A, bash("grep -nE '\\.env|runbook' README.md")),
    (B, bash("grep -c DATABASE_URL ./.env")),
    (A, bash("env FOO=1 pnpm test")),
    (A, bash("echo $HOME $PATH")),
    (A, bash(f"node .claude/skills/run-app/check-local-env.mjs {H}/work/app/main")),
    (A, bash("jq -r '.hooks | keys[]' ~/.claude/settings.json")),
    (A, bash("cat ~/.ssh/id_ed25519.pub")),
    (A, bash("git status --porcelain && git diff --stat")),
    (A, bash("python3 - <<'EOF'\nt = open('README.md').read()\nt = t.replace('the .env files', 'the .env.local file')\nopen('README.md','w').write(t)\nEOF")),
    (A, bash("cat > notes.md <<'EOF'\nNever cat .env; use DOTENV_CONFIG_PATH instead.\nEOF")),
    (A, read(f"{H}/work/app/main/.env.example")),
    (A, read(f"{H}/work/app/main/lib/env.ts")),
    (A, read(f"{H}/.zshrc")),
    (A, read("~/.ssh/config")),
    (A, ("Grep", {"pattern": "process.env", "path": "lib"})),
    (A, ("Glob", {"pattern": ".env*"})),
]

fail = 0
for expect, (tool, inp) in CASES:
    payload = json.dumps({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": inp, "cwd": CWD})
    out = subprocess.run([HOOK], input=payload, text=True, capture_output=True).stdout
    got = B if '"deny"' in out else A
    ok = got == expect
    fail += not ok
    label = inp.get("command") or inp.get("file_path") or json.dumps(inp)
    print(f"{'PASS' if ok else 'FAIL'}  {expect:5s} {tool:5s} {label.splitlines()[0][:78]}")
print(f"\n{len(CASES) - fail}/{len(CASES)} passed")
sys.exit(1 if fail else 0)
