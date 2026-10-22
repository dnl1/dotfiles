"""Exercise the configured popup command without opening Herdr or contacting GitHub."""

import json
import os
from pathlib import Path
import pty
import select
import subprocess
import sys
import tempfile
import time
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]
CONFIG = tomllib.loads((ROOT / "ai/herdr/config.toml").read_text())
POPUP = next(command for command in CONFIG["keys"]["command"]
             if command["key"] == "prefix+ctrl+p")


class PrPopupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.cwd = self.home / "repo with spaces"
        self.cwd.mkdir()
        self.log = self.home / "dash.json"
        binaries = self.home / "bin"
        binaries.mkdir()
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
            "HERDR_ACTIVE_PANE_ID": "w2:p7",
            "GH_REPO": "wrong/repository",
            "FAKE_REPO": "owner/current-repo",
            "FAKE_PANE": json.dumps({"result": {"pane": {
                "foreground_cwd": str(self.cwd), "cwd": "/wrong-directory",
            }}}),
            "DASH_LOG": str(self.log),
        }
        self.env.pop("XDG_CONFIG_HOME", None)
        self.stub(binaries / "herdr", """
import os, sys
assert sys.argv[1:] == ["pane", "get", "w2:p7"]
print(os.environ["FAKE_PANE"])
sys.exit(int(os.environ.get("FAKE_HERDR_STATUS", "0")))
""")
        self.stub(binaries / "gh", """
import json, os, pathlib, sys
if sys.argv[1:] == ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]:
    assert "GH_REPO" not in os.environ
    here = pathlib.Path.cwd().name
    if here in os.environ.get("FAKE_CHILD_REPOS", "").split(","):
        print("owner/" + here.replace(" ", "-"))
        sys.exit(0)
    if os.environ.get("FAKE_GH_FAIL"):
        sys.exit(1)
    print(os.environ["FAKE_REPO"])
elif sys.argv[1:2] == ["dash"]:
    pathlib.Path(os.environ["DASH_LOG"]).write_text(json.dumps({
        "cwd": os.getcwd(), "repo": os.environ.get("GH_REPO"), "args": sys.argv[1:],
    }))
else:
    sys.exit(2)
""")

    def stub(self, path, source):
        path.write_text(f"#!{sys.executable}\n" + source)
        path.chmod(0o755)

    def launch(self):
        return subprocess.run(["sh", "-c", POPUP["command"]], env=self.env,
                              cwd=self.home, capture_output=True, text=True,
                              stdin=subprocess.DEVNULL)

    def test_binding_is_a_popup_and_lazygit_binding_is_preserved(self):
        self.assertEqual(POPUP["type"], "popup")
        self.assertEqual((POPUP["width"], POPUP["height"]), ("85%", "92%"))
        self.assertTrue(any(command["key"] == "prefix+ctrl+g"
                            for command in CONFIG["keys"]["command"]))

    def test_focused_repository_overrides_inherited_repository(self):
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        launched = json.loads(self.log.read_text())
        self.assertEqual(launched["cwd"], str(self.cwd))
        self.assertEqual(launched["repo"], "owner/current-repo")
        self.assertEqual(launched["args"], [
            "dash", "--config", str(self.home / ".config/gh-dash/config.yml"),
        ])

    def test_respects_xdg_config_home(self):
        config_home = self.home / "custom config"
        self.env["XDG_CONFIG_HOME"] = str(config_home)
        self.assertEqual(self.launch().returncode, 0)
        self.assertEqual(json.loads(self.log.read_text())["args"][-1],
                         str(config_home / "gh-dash/config.yml"))

    def test_falls_back_to_pane_cwd(self):
        self.env["FAKE_PANE"] = json.dumps({"result": {"pane": {"cwd": str(self.cwd)}}})
        self.assertEqual(self.launch().returncode, 0)
        self.assertEqual(json.loads(self.log.read_text())["cwd"], str(self.cwd))

    def test_missing_or_invalid_pane_never_launches_dashboard(self):
        for pane in ("invalid json", "{}", json.dumps({"result": {"pane": {
            "foreground_cwd": str(self.home / "missing-directory"),
        }}})):
            with self.subTest(pane=pane):
                self.env["FAKE_PANE"] = pane
                self.assertNotEqual(self.launch().returncode, 0)
                self.assertFalse(self.log.exists())

    def test_failed_pane_lookup_never_uses_its_output(self):
        self.env["FAKE_HERDR_STATUS"] = "1"
        self.assertNotEqual(self.launch().returncode, 0)
        self.assertFalse(self.log.exists())

    def test_missing_github_repository_never_opens_global_dashboard(self):
        self.env["FAKE_GH_FAIL"] = "1"
        self.assertNotEqual(self.launch().returncode, 0)
        self.assertFalse(self.log.exists())

    def test_empty_github_repository_never_opens_global_dashboard(self):
        self.env["FAKE_REPO"] = ""
        self.assertNotEqual(self.launch().returncode, 0)
        self.assertFalse(self.log.exists())

    def workspace(self, *children):
        """Turn the pane's directory into a folder of clones, none a GitHub repo itself."""
        self.env["FAKE_GH_FAIL"] = "1"
        for child in children:
            (self.cwd / child / ".git").mkdir(parents=True)
        (self.cwd / "not a clone").mkdir()
        config = self.home / ".config/gh-dash/config.yml"
        config.parent.mkdir(parents=True)
        config.write_text("prSections:\n"
                          "  - title: Open\n"
                          "    filters: is:open\n"
                          "  - title: Mine\n"
                          "    filters: \"is:open author:@me\"\n"
                          "smartFilteringAtLaunch: true\n")

    def test_workspace_shows_the_prs_of_every_clone_in_it(self):
        self.workspace("api", "web app", "unpublished")
        self.env["FAKE_CHILD_REPOS"] = "api,web app"
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        launched = json.loads(self.log.read_text())
        scoped = self.home / ".cache/herdr/pr-popup.yml"
        self.assertEqual(launched["args"], ["dash", "--config", str(scoped)])
        self.assertIsNone(launched["repo"])
        self.assertEqual(scoped.read_text(), "prSections:\n"
                         "  - title: Open\n"
                         "    filters: repo:owner/api repo:owner/web-app is:open\n"
                         "  - title: Mine\n"
                         "    filters: \"repo:owner/api repo:owner/web-app is:open author:@me\"\n"
                         "smartFilteringAtLaunch: true\n")

    def test_workspace_without_github_clones_never_opens_global_dashboard(self):
        self.workspace("unpublished")
        result = self.launch()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is not a GitHub repository, nor a folder of them.", result.stderr)
        self.assertFalse(self.log.exists())

    def test_failure_says_why(self):
        self.env["FAKE_GH_FAIL"] = "1"
        result = self.launch()
        self.assertIn(f"{self.cwd} is not a GitHub repository, nor a folder of them.",
                      result.stderr)

    def test_failure_waits_for_enter_on_a_terminal(self):
        # Herdr closes the popup the moment the command exits, so on a terminal
        # the message has to stay until it is read.
        self.env["FAKE_GH_FAIL"] = "1"
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(self.home)
            os.execvpe("sh", ["sh", "-c", POPUP["command"]], self.env)
        def reap():
            try:
                os.kill(pid, 9)
                os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        self.addCleanup(reap)
        shown = b""
        deadline = time.monotonic() + 5
        while b"Press Enter" not in shown and time.monotonic() < deadline:
            if select.select([fd], [], [], 0.2)[0]:
                shown += os.read(fd, 4096)
        self.assertIn(b"nor a folder of them.", shown)
        time.sleep(0.5)
        self.assertEqual(os.waitpid(pid, os.WNOHANG), (0, 0), "exited before Enter")
        os.write(fd, b"\n")
        # macOS only lets the child be reaped once the terminal is read to EOF.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if select.select([fd], [], [], 0.2)[0] and not os.read(fd, 4096):
                    break
            except OSError:
                break
        _, status = os.waitpid(pid, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 1)
        self.assertFalse(self.log.exists())


if __name__ == "__main__":
    unittest.main()
