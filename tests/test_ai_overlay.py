"""Exercise public/private bootstrap paths offline with a temporary HOME."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP = (ROOT / "ai/bootstrap.sh").read_text()
MCP_PY = re.search(r'python3 - "\$SECRETS".*?<<\'PY\' \|\n(.*?)\nPY', BOOTSTRAP, re.S).group(1)
CREDENTIALS = BOOTSTRAP.split('step "MCP credentials"\n', 1)[1].split('# ── TypeScript', 1)[0]
HERDR = BOOTSTRAP.split('step "herdr, lazygit and gh-dash"\n', 1)[1].split('# lazygit reads', 1)[0]


class OverlayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.ai = self.home / "checkout/ai"
        (self.ai / "mcp").mkdir(parents=True)
        (self.ai / "mcp/secrets.env.example").write_text("PUBLIC_TEMPLATE=1\n")
        shutil.copy2(ROOT / "ai/mcp/with-secrets.sh", self.ai / "mcp/with-secrets.sh")
        self.bin = self.home / "bin"
        self.bin.mkdir()
        (self.home / ".local/bin").mkdir(parents=True)
        (self.home / ".pi/agent/extensions").mkdir(parents=True)
        self.env = {**os.environ, "HOME": str(self.home),
                    "PATH": f"{self.bin}:{self.home}/.local/bin:/usr/bin:/bin",
                    "AI_DIR": str(self.ai), "PI_DIR": str(self.home / ".pi/agent")}

    def shell(self, script):
        return subprocess.run(["/bin/bash", "-c", "set -euo pipefail\n"
                               "step() { :; }; skip() { :; }; ok() { :; }; warn() { echo \"$*\"; }\n" + script],
                              env=self.env, text=True, capture_output=True, check=True, timeout=10)

    def stub(self, path, code):
        path.write_text(f"#!{sys.executable}\n" + code)
        path.chmod(0o755)

    def test_public_credentials_without_work_overlay(self):
        self.shell(CREDENTIALS)
        secrets = self.home / ".config/ai-mcp/secrets.env"
        self.assertEqual(secrets.read_text(), "PUBLIC_TEMPLATE=1\n")
        self.assertEqual(secrets.stat().st_mode & 0o777, 0o600)
        self.assertFalse((secrets.parent / "aws").exists())
        self.assertTrue((self.home / ".local/bin/ai-mcp-with-secrets").is_file())

    def test_work_template_and_optional_installer_preserve_existing_credentials(self):
        (self.ai / "work/mcp").mkdir(parents=True)
        (self.ai / "work/mcp/secrets.env.example").write_text("WORK_TEMPLATE=1\n")
        (self.ai / "work/bootstrap.sh").write_text('touch "$HOME/overlay-ran"\n')
        self.shell(CREDENTIALS)
        secrets = self.home / ".config/ai-mcp/secrets.env"
        self.assertEqual(secrets.read_text(), "WORK_TEMPLATE=1\n")
        self.assertTrue((self.home / "overlay-ran").exists())
        secrets.write_text("EXISTING=keep\n")
        self.shell(CREDENTIALS)
        self.assertEqual(secrets.read_text(), "EXISTING=keep\n")

    def mcp_rows(self, overlay=None):
        base = self.home / "base.json"
        work = self.home / "work.json"
        secrets = self.home / "secrets.env"
        current = self.home / "claude.json"
        base.write_text(json.dumps({"base": {"command": "__HOME__/tool"},
                                    "shared": {"command": "old"}}))
        secrets.write_text("")
        current.write_text(json.dumps({"mcpServers": {"shared": {"command": "old"}}}))
        if overlay is not None:
            work.write_text(json.dumps(overlay))
        result = subprocess.run([sys.executable, "-", str(secrets), "Darwin", str(self.home),
                                 str(current), str(base), str(work)], input=MCP_PY,
                                text=True, capture_output=True, check=True, timeout=10)
        return {parts[0]: parts[1:] for parts in
                (line.split("\x1f") for line in result.stdout.splitlines())}

    def test_missing_work_mcp_file_is_optional(self):
        rows = self.mcp_rows()
        self.assertEqual(set(rows), {"base", "shared"})
        self.assertEqual(rows["shared"][0], "same")
        self.assertEqual(json.loads(rows["base"][-1])["command"], f"{self.home}/tool")

    def test_work_mcp_layer_overrides_base_and_keeps_prerequisite_checks(self):
        rows = self.mcp_rows({"shared": {"command": "new"},
                              "gated": {"command": "tool", "_requires_env": ["OPTIONAL_KEY"]},
                              "linux": {"command": "tool", "_only_os": "Linux"}})
        self.assertEqual(rows["shared"][0], "differs")
        self.assertEqual(rows["gated"][1], "OPTIONAL_KEY")
        self.assertNotIn("_requires_env", json.loads(rows["gated"][-1]))
        self.assertNotIn("linux", rows)

    def test_zsh_dropins_are_optional_and_loaded_when_present(self):
        zsh = shutil.which("zsh")
        if not zsh:
            self.skipTest("zsh unavailable")
        script = f'source "{ROOT}/ai/shell/devenv.zsh"; print -r -- "${{TEST_DROPIN:-absent}}"'
        def run():
            return subprocess.run([zsh, "-f", "-c", script], env=self.env,
                                  text=True, capture_output=True, check=True).stdout.strip()
        self.assertEqual(run(), "absent")
        dropins = self.home / ".config/zsh/devenv.d"
        dropins.mkdir(parents=True)
        (dropins / "test.zsh").write_text("TEST_DROPIN=loaded\n")
        self.assertEqual(run(), "loaded")

    def test_sync_detects_default_branch(self):
        sync = (ROOT / "ai/sync.sh").read_text()
        branch_code = sync.split("# origin/HEAD", 1)[1].split('OS="$(uname -s)"', 1)[0]
        branch_code = branch_code[branch_code.index('BRANCH='):]
        repo = self.home / "git checkout"
        subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
        for expected in ("main", "master"):
            subprocess.run(["git", "-C", str(repo), "symbolic-ref", "refs/remotes/origin/HEAD",
                            f"refs/remotes/origin/{expected}"], check=True, capture_output=True)
            self.env["REPO_DIR"] = str(repo)
            result = self.shell(branch_code + '\nprintf "%s" "$BRANCH"')
            self.assertEqual(result.stdout, expected)

    def test_public_autosync_is_opt_in_and_private_default_is_preserved(self):
        gate = BOOTSTRAP.split('origin_url="', 1)[1].split('elif [ "$OS" = Darwin ]; then', 1)[0]
        gate = 'origin_url="' + gate + 'else echo scheduled; fi\n'
        repo = self.ai.parent
        subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(repo), "remote", "add", "origin", "placeholder"],
                       check=True, capture_output=True)
        for url, opt_in, expected in (
            ("git@github.com:dnl1/.dotfiles.git", "", "scheduled"),
            ("https://github.com/dnl1/.dotfiles.git", "", "scheduled"),
            ("https://github.com/dnl1/dotfiles.git", "", ""),
            ("https://github.com/dnl1/dotfiles.git", "1", "scheduled"),
        ):
            with self.subTest(url=url, opt_in=opt_in):
                subprocess.run(["git", "-C", str(repo), "remote", "set-url", "origin", url],
                               check=True, capture_output=True)
                self.env.update(DOTFILES_AUTO_SYNC=opt_in, DOTFILES_SYNC="")
                self.assertEqual(self.shell(gate).stdout.strip(), expected)

    def setup_herdr(self, present=True, current=""):
        (self.ai / "herdr").mkdir()
        (self.ai / "herdr/config.toml").write_text("onboarding = false\n")
        self.env.update(FAKE_CURRENT=current, FAKE_CALLS=str(self.home / "calls"))
        fake = self.home / "herdr-source"
        self.stub(fake, '''import os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_CALLS"], "a") as log:
    log.write(" ".join(args) + "\\n")
if args == ["--version"]:
    print("herdr test")
elif args == ["integration", "status"]:
    for agent in os.environ["FAKE_CURRENT"].split(","):
        print(agent + ": current (v1)")
''')
        self.env["FAKE_HERDR"] = str(fake)
        self.stub(self.bin / "curl", '''import os
with open(os.environ["FAKE_CALLS"], "a") as log:
    log.write("download\\n")
print('cp "$FAKE_HERDR" "$HOME/.local/bin/herdr"; chmod +x "$HOME/.local/bin/herdr"')
''')
        for agent in ("claude", "opencode"):
            self.stub(self.bin / agent, "pass\n")
        if present:
            shutil.copy2(fake, self.home / ".local/bin/herdr")

    def test_existing_herdr_and_current_integrations_are_not_reinstalled(self):
        self.setup_herdr(current="pi,claude,opencode")
        self.shell(HERDR)
        calls = (self.home / "calls").read_text()
        self.assertNotIn("download", calls)
        self.assertNotIn("integration install", calls)
        self.assertTrue((self.home / ".config/herdr/config.toml").is_symlink())

    def test_missing_herdr_installs_then_registers_agents(self):
        self.setup_herdr(present=False)
        self.shell(HERDR)
        calls = (self.home / "calls").read_text()
        self.assertIn("download", calls)
        for agent in ("pi", "claude", "opencode"):
            self.assertIn("integration install " + agent, calls)


if __name__ == "__main__":
    unittest.main()
