"""Exercise ai-memory wiring with fake services, clients, and a temporary home."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP = (ROOT / "ai/bootstrap.sh").read_text()
HEALTH = re.search(r"^aim_server_healthy\(\) \{.*?^\}", BOOTSTRAP, re.M | re.S).group()
CLAUDE = BOOTSTRAP.split('step "ai-memory"\n', 1)[1].split(
    "# ── codebase-memory-mcp", 1)[0]
PI = BOOTSTRAP.split("# ai-memory reaches pi through its own extension", 1)[1]
PI = PI[PI.index("if aim_server_healthy;"):].split("# With the extension in place", 1)[0]


class MemoryBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.calls = self.home / "calls.jsonl"
        self.curl_calls = self.home / "curl.jsonl"
        self.docker_calls = self.home / "docker.jsonl"
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "FAKE_CALLS": str(self.calls),
            "FAKE_CURL_CALLS": str(self.curl_calls),
            "FAKE_DOCKER_CALLS": str(self.docker_calls),
            "FAKE_HEALTH_CODE": "200",
            "FAKE_CONTAINER": "true",
        }
        for name in ("FAKE_FAIL_COMMAND", "FAKE_START_FAIL"):
            self.env.pop(name, None)
        self.stub(self.bin / "docker", """
import json, os, pathlib, sys
with pathlib.Path(os.environ['FAKE_DOCKER_CALLS']).open('a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1] == 'inspect':
    if os.environ['FAKE_CONTAINER'] == 'missing':
        sys.exit(1)
    print(os.environ['FAKE_CONTAINER'])
elif sys.argv[1] == 'start' and os.environ.get('FAKE_START_FAIL'):
    sys.exit(1)
""")
        self.stub(self.bin / "curl", """
import json, os, pathlib, sys
with pathlib.Path(os.environ['FAKE_CURL_CALLS']).open('a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
url = sys.argv[-1]
print(os.environ['FAKE_HEALTH_CODE'] if url.endswith('/healthz') else '401', end='')
""")
        self.stub(self.bin / "systemctl", "pass\n")
        self.stub(self.bin / "sleep", "pass\n")
        self.stub(self.bin / "opencode", "import sys; sys.exit(1)\n")
        self.stub(self.bin / "jq", """
import json, sys
with open(sys.argv[-1]) as f:
    data = json.load(f)
sys.exit(0 if data.get('autoMemoryEnabled') is False else 1)
""")
        self.native = self.home / ".local/opt/ai-memory/ai-memory"
        self.stub(self.native, """
import json, os, pathlib, sys
args = sys.argv[1:]
if '--version' in args:
    print('ai-memory 3.1.2')
    sys.exit(0)
while args and args[0] in ('--data-dir', '--config'):
    args = args[2:]
with pathlib.Path(os.environ['FAKE_CALLS']).open('a') as log:
    log.write(json.dumps(args) + '\\n')
if args and args[0] == os.environ.get('FAKE_FAIL_COMMAND'):
    sys.exit(9)
print('Updated owned ai-memory assets.')
""")
        for path in (".config/ai-memory/config.toml", ".config/systemd/user/ai-memory.service"):
            target = self.home / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("")
        self.settings = self.home / ".claude/settings.json"
        self.settings.parent.mkdir()
        self.settings.write_text(json.dumps({"autoMemoryEnabled": False}))
        self.instructions = self.home / ".claude/CLAUDE.md"
        self.instructions.write_text(
            "Keep these user rules.\n\n<!-- ai-memory:start -->\nOld managed block.\n"
            "<!-- ai-memory:end -->\n\n@WRITING.md\n")
        (self.home / ".claude/skills/ai-memory-retrieval").mkdir(parents=True)

    def stub(self, path, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"#!{sys.executable}\n" + body)
        path.chmod(0o755)

    def launch(self, section=CLAUDE):
        script = """set -euo pipefail
OS=Linux
ARCH=x86_64
AIM_PORT=49374
PI_DIR="$HOME/.pi/agent"
AIM_CLI=("$HOME/.local/opt/ai-memory/ai-memory")
step() { :; }
skip() { :; }
ok() { :; }
warn() { :; }
die() { exit 1; }
""" + HEALTH + "\n" + section
        return subprocess.run(["bash", "-c", script], env=self.env,
                              capture_output=True, text=True)

    def recorded(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def docker(self):
        if not self.docker_calls.exists():
            return []
        return [json.loads(line) for line in self.docker_calls.read_text().splitlines()]

    def test_stopped_container_is_started_before_wiring(self):
        self.env["FAKE_CONTAINER"] = "false"
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["start", "ai-memory"], self.docker())
        self.assertEqual(self.recorded()[0][0], "install-hooks")

    def test_running_or_missing_container_is_left_alone(self):
        for state in ("true", "missing"):
            with self.subTest(state=state):
                self.docker_calls.unlink(missing_ok=True)
                self.env["FAKE_CONTAINER"] = state
                self.assertEqual(self.launch().returncode, 0)
                self.assertEqual([call[0] for call in self.docker()], ["inspect"])

    def test_failed_container_start_does_not_abort_the_bootstrap(self):
        self.env.update(FAKE_CONTAINER="false", FAKE_START_FAIL="1", FAKE_HEALTH_CODE="000")
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_existing_hooks_skills_and_instructions_are_refreshed(self):
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call[0] for call in self.recorded()], [
            "install-hooks", "install-mcp", "install-skills", "install-instructions",
        ])
        self.assertIn("Keep these user rules.", self.instructions.read_text())

    def test_claude_mcp_is_session_aware(self):
        self.assertEqual(self.launch().returncode, 0)
        mcp = next(call for call in self.recorded() if call[0] == "install-mcp")
        self.assertIn("--session-aware", mcp)
        self.assertIn("--apply", mcp)

    def test_health_probe_works_when_mcp_requires_auth(self):
        self.assertEqual(self.launch().returncode, 0)
        calls = [json.loads(line) for line in self.curl_calls.read_text().splitlines()]
        self.assertTrue(calls)
        for call in calls:
            self.assertEqual(call[-1], "http://127.0.0.1:49374/healthz")
            self.assertEqual(call[call.index("--max-time") + 1], "3")

    def test_wiring_failure_is_not_reported_as_success(self):
        self.env["FAKE_FAIL_COMMAND"] = "install-hooks"
        result = self.launch()
        self.assertEqual(result.returncode, 9, result.stderr)
        self.assertEqual([call[0] for call in self.recorded()], ["install-hooks"])

    def test_native_claude_memory_is_not_disabled_or_imported(self):
        self.settings.write_text(json.dumps({"autoMemoryEnabled": True}))
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(self.settings.read_text())["autoMemoryEnabled"])
        self.assertNotIn("install-instructions", [call[0] for call in self.recorded()])
        self.assertNotIn("<!-- ai-memory:start -->", self.instructions.read_text())
        self.assertIn("Keep these user rules.", self.instructions.read_text())
        self.assertIn("@WRITING.md", self.instructions.read_text())

    def test_pi_gets_its_own_global_routing_block(self):
        result = self.launch(PI)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.recorded()
        self.assertEqual(calls[0], ["install-hooks", "--agent", "pi", "--project-strategy", "repo-root", "--apply"])
        self.assertEqual(calls[1], ["install-instructions", "--target",
                         str(self.home / ".pi/agent/AGENTS.md"), "--compact", "--no-skills"])

    def test_unreachable_server_does_not_rewire_clients(self):
        self.env["FAKE_HEALTH_CODE"] = "000"
        self.assertEqual(self.launch().returncode, 0)
        self.assertEqual(self.recorded(), [])

    def test_broken_opencode_launcher_is_not_wired(self):
        self.assertEqual(self.launch().returncode, 0)
        self.assertFalse(any("opencode" in call for call in self.recorded()))

    def test_opencode_v2_uses_the_explicit_alias_for_container_installers(self):
        self.stub(self.bin / "opencode", "print('opencode v2.0.30')\n")
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.recorded()
        self.assertEqual(calls[-2], ["install-hooks", "--agent", "opencode2",
                                    "--project-strategy", "repo-root", "--apply"])
        self.assertEqual(calls[-1], ["install-mcp", "--client", "opencode2", "--apply"])


if __name__ == "__main__":
    unittest.main()
