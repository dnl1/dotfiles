"""Test hook installation and checkout discovery without syncing the public repo."""

import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
LEGACY_HOOK = """#!/usr/bin/env bash
# Syncs safe files to public repo before every push from ~/.dotfiles.
while IFS= read -r _; do :; done
"$HOME/.dotfiles/sync-public.sh" || true
exit 0
"""


class DotfilesPrePushTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.home = self.base / "home"
        self.repo = self.home / "work repos" / ".dotfiles"
        self.repo.mkdir(parents=True)
        self.calls = self.base / "sync-calls"
        self.env = {
            **{key: value for key, value in os.environ.items()
               if not key.startswith("GIT_")},
            "HOME": str(self.home),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "SYNC_CALLS": str(self.calls),
            "SYNC_EXIT": "0",
        }
        self.run_command("git", "init", "-q", str(self.repo))
        shutil.copy2(ROOT / "install-dotfiles.sh", self.repo)
        (self.repo / "sync-public.sh").write_text("""#!/usr/bin/env bash
printf '%s\\n' "$0" >> "$SYNC_CALLS"
if IFS= read -r line; then
  echo "hook did not drain stdin" >&2
  exit 31
fi
exit "$SYNC_EXIT"
""")
        (self.repo / "sync-public.sh").chmod(0o755)

    @property
    def hook(self):
        return self.repo / ".git/hooks/pre-push"

    def run_command(self, *args, cwd=None, input=""):
        return subprocess.run(
            args, cwd=cwd or self.base, env=self.env, input=input,
            text=True, capture_output=True, check=True, timeout=10,
        )

    def install(self):
        return self.run_command(
            "bash", str(self.repo / "install-dotfiles.sh"),
            "--home", str(self.base / "install-home"),
        )

    def push_hook(self, cwd=None):
        return self.run_command(
            str(self.hook), cwd=cwd or self.repo,
            input="refs/heads/master local refs/heads/master remote\n",
        )

    def test_mac_checkout_with_spaces_ignores_home_dotfiles(self):
        decoy = self.home / ".dotfiles"
        decoy.mkdir()
        (decoy / "sync-public.sh").write_text("#!/usr/bin/env bash\nexit 99\n")
        (decoy / "sync-public.sh").chmod(0o755)
        self.install()
        subdir = self.repo / "nested"
        subdir.mkdir()
        result = self.push_hook(cwd=subdir)
        self.assertEqual(result.stderr, "")
        self.assertEqual(self.calls.read_text(), f"{self.repo}/sync-public.sh\n")
        self.assertTrue(os.access(self.hook, os.X_OK))

    def test_wsl_home_checkout(self):
        target = self.home / ".dotfiles"
        self.repo.rename(target)
        self.repo = target
        self.install()
        self.assertEqual(self.push_hook().stderr, "")
        self.assertEqual(self.calls.read_text(), f"{target}/sync-public.sh\n")

    def test_installer_upgrades_legacy_hook_and_is_idempotent(self):
        self.hook.write_text(LEGACY_HOOK)
        self.hook.chmod(0o755)
        self.assertIn("Installed pre-push hook", self.install().stdout)
        upgraded = self.hook.read_bytes()
        self.assertEqual(self.push_hook().stderr, "")
        self.assertIn("already installed", self.install().stdout)
        self.assertEqual(self.hook.read_bytes(), upgraded)

    def test_installer_preserves_custom_hook(self):
        custom = "#!/usr/bin/env bash\n# custom sync-public.sh integration\nexit 7\n"
        self.hook.write_text(custom)
        self.assertIn("custom hook exists", self.install().stdout)
        self.assertEqual(self.hook.read_text(), custom)

    def test_failed_sync_warns_with_quoted_checkout_path_without_blocking(self):
        self.install()
        self.env["SYNC_EXIT"] = "7"
        result = self.push_hook()
        self.assertIn("public sync failed", result.stderr)
        command = result.stderr.split("run ", 1)[1].split(" manually", 1)[0]
        self.assertEqual(shlex.split(command), [str(self.repo / "sync-public.sh")])

    def test_missing_sync_script_does_not_block(self):
        self.install()
        (self.repo / "sync-public.sh").unlink()
        self.assertIn("public sync failed", self.push_hook().stderr)

    def test_public_clone_gets_no_hook(self):
        (self.repo / "sync-public.sh").unlink()
        self.assertIn("public clone", self.install().stdout)
        self.assertFalse(self.hook.exists())

    def test_missing_git_checkout_warns_without_running_sync(self):
        self.install()
        result = self.push_hook(cwd=self.base)
        self.assertIn("cannot locate dotfiles checkout", result.stderr)
        self.assertFalse(self.calls.exists())

    def test_real_git_push_runs_hook_and_tolerates_sync_failure(self):
        self.install()
        self.run_command(
            "git", "-c", "user.name=Hook test", "-c", "user.email=test@example.com",
            "commit", "--allow-empty", "-qm", "Test hook", cwd=self.repo,
        )
        remote = self.base / "remote.git"
        self.run_command("git", "init", "--bare", "-q", str(remote))
        self.env["SYNC_EXIT"] = "7"
        result = self.run_command(
            "git", "push", str(remote), "HEAD:refs/heads/test", cwd=self.repo,
        )
        self.assertIn("public sync failed", result.stderr)
        self.assertEqual(self.calls.read_text(), f"{self.repo}/sync-public.sh\n")
        self.run_command("git", "--git-dir", str(remote), "rev-parse", "refs/heads/test")


if __name__ == "__main__":
    unittest.main()
