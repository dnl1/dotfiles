"""Publish only committed, reviewed snapshots to a local fake public remote."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_URL = "https://github.com/dnl1/dotfiles.git"


@unittest.skipUnless((ROOT / "sync-public.sh").exists(), "Private publisher is absent in public clones")
class PublicSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.home = self.base / "home with spaces"
        self.home.mkdir()
        self.private = self.base / "private checkout"
        self.private.mkdir()
        self.public = self.home / ".dotfiles-public"
        self.remote = self.base / "public.git"
        self.env = {
            **{k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
            "HOME": str(self.home), "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": str(self.base / "gitconfig"),
            "GIT_TERMINAL_PROMPT": "0",
        }
        self.command("git", "init", "--bare", "-qb", "main", str(self.remote))
        seed = self.base / "seed"
        self.command("git", "init", "-qb", "main", str(seed))
        (seed / "README.md").write_text("Old public version\n")
        self.commit(seed)
        self.command("git", "-C", str(seed), "push", "-q", str(self.remote), "main")
        self.command("git", "config", "--global", f"url.file://{self.remote}.insteadOf", PUBLIC_URL)
        self.command("git", "init", "-qb", "master", str(self.private))
        shutil.copy2(ROOT / "sync-public.sh", self.private)
        self.put("ai/work/public-deny.txt", "# Never publish\ninternal-only-marker\n")
        self.put("ai/work/private.txt", "internal-only-marker\n")
        self.put("ai/pi/settings.base.json", "{}\n")
        self.put("ai/README.md", "Public AI setup\n")
        self.put("README.md", "New public version\n")
        self.put(".tmux.conf", "set -g mouse on\n")
        self.put(".gitconfig", "[user]\n  name = Private User\n  email = internal-only-marker@example.com\n")
        self.commit(self.private)

    def command(self, *args, cwd=None, check=True):
        return subprocess.run(args, cwd=cwd or self.base, env=self.env,
                              text=True, capture_output=True, check=check, timeout=20)

    def put(self, rel, content):
        path = self.private / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def commit(self, repo):
        self.command("git", "-C", str(repo), "add", "-A")
        self.command("git", "-C", str(repo), "-c", "user.name=Test",
                 "-c", "user.email=test@example.com", "commit", "-qm", "AI setup")

    def sync(self, *args, check=True):
        return self.command("bash", str(self.private / "sync-public.sh"), *args, check=check)

    def remote_head(self):
        return self.command("git", "--git-dir", str(self.remote), "rev-parse", "main").stdout

    def test_snapshot_excludes_work_private_tests_untracked_and_uncommitted_content(self):
        private_tests = ("tests/test_withdb.py", "tests/test_credential_instructions.py")
        for path in private_tests:
            self.put(path, "internal-only-marker\n")
        self.put("tests/test_public_feature.py", "# Public regression fixture\n")
        self.commit(self.private)
        self.put("ai/private-untracked.txt", "internal-only-marker\n")
        self.put("ai/pi/settings.base.json", "internal-only-marker\n")
        before = self.command("git", "-C", str(self.private), "status", "--porcelain").stdout
        self.sync()
        self.assertFalse((self.public / "ai/work").exists())
        for path in private_tests:
            self.assertFalse((self.public / path).exists())
        self.assertTrue((self.public / "tests/test_public_feature.py").is_file())
        self.assertFalse((self.public / "ai/private-untracked.txt").exists())
        self.assertEqual((self.public / "ai/pi/settings.base.json").read_text(), "{}\n")
        self.assertTrue((self.public / ".tmux.conf").exists())
        self.assertIn("dnl1@users.noreply.github.com", (self.public / ".gitconfig").read_text())
        self.assertIn("name = Dotfiles", (self.public / ".gitconfig").read_text())
        self.assertNotIn("Private User", (self.public / ".gitconfig").read_text())
        self.assertIn("internal-only-marker", (self.private / ".gitconfig").read_text())
        self.assertEqual(before, self.command("git", "-C", str(self.private), "status", "--porcelain").stdout)
        email = self.command("git", "-C", str(self.public), "log", "-1", "--format=%ae %ce").stdout
        self.assertEqual(email.strip(), "dnl1@users.noreply.github.com dnl1@users.noreply.github.com")
        self.assertEqual(self.command("git", "-C", str(self.public), "config", "--get", "remote.origin.url").stdout.strip(), PUBLIC_URL)

    def test_public_commit_ignores_private_messages_and_inherited_identity(self):
        self.command("git", "-C", str(self.private), "-c", "user.name=Private User",
                     "-c", "user.email=private@example.com", "commit", "--allow-empty",
                     "-qm", "internal-only-marker")
        self.env.update({
            "GIT_AUTHOR_NAME": "Private User", "GIT_AUTHOR_EMAIL": "private@example.com",
            "GIT_COMMITTER_NAME": "Private User", "GIT_COMMITTER_EMAIL": "private@example.com",
        })
        self.sync()
        metadata = self.command("git", "-C", str(self.public), "log", "-1",
                                "--format=%an|%ae|%cn|%ce|%s").stdout.strip()
        self.assertEqual(metadata, "Dotfiles|dnl1@users.noreply.github.com|"
                         "Dotfiles|dnl1@users.noreply.github.com|chore: sync public configuration")

    def test_push_hook_git_environment_does_not_retarget_the_public_clone(self):
        self.command("git", "clone", "-q", PUBLIC_URL, str(self.public))
        self.command("git", "-C", str(self.private), "remote", "add", "origin", "https://example.invalid/private.git")
        before = self.command("git", "-C", str(self.private), "rev-parse", "HEAD").stdout
        inherited = {
            "GIT_DIR": str(self.private / ".git"),
            "GIT_WORK_TREE": str(self.private),
            "GIT_INDEX_FILE": str(self.private / ".git/index"),
        }
        self.env.update(inherited)
        try:
            result = self.sync(check=False)
        finally:
            for name in inherited:
                self.env.pop(name)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.public / "README.md").read_text(), "New public version\n")
        self.assertEqual(before, self.command("git", "-C", str(self.private), "rev-parse", "HEAD").stdout)
        self.assertEqual(self.command("git", "-C", str(self.public), "config", "--get", "remote.origin.url").stdout.strip(), PUBLIC_URL)

    def test_dry_run_lists_files_without_pushing(self):
        before = self.remote_head()
        result = self.sync("--dry-run")
        self.assertIn("ai/pi/settings.base.json", result.stdout)
        self.assertNotIn("ai/work", result.stdout)
        self.assertEqual(before, self.remote_head())
        self.sync()
        self.assertNotEqual(before, self.remote_head())

    def test_denied_content_aborts_without_printing_it_or_changing_remote(self):
        self.put("ai/leak.txt", "internal-only-marker is private\n")
        self.commit(self.private)
        before = self.remote_head()
        result = self.sync(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ai/leak.txt", result.stderr)
        self.assertNotIn("internal-only-marker", result.stderr)
        self.assertEqual(before, self.remote_head())
        self.assertFalse(self.public.exists())

    def test_private_rules_reject_credential_formats_without_printing_matches(self):
        rules = (ROOT / "ai/work/public-deny.txt").read_text()
        self.put("ai/work/public-deny.txt", rules)
        examples = [
            "-----BEGIN " + "PRIVATE KEY-----",
            "github_pat_" + "x" * 30,
            "AKIA" + "A" * 16,
            "xoxb-" + "x" * 20,
            "sk-" + "x" * 32,
            "https://hooks.slack.com/" + "services/test",
            "postgresql://" + "user:password@example.invalid/db",
        ]
        for example in examples:
            with self.subTest(kind=examples.index(example)):
                self.put("ai/leak.txt", example + "\n")
                self.commit(self.private)
                result = self.sync(check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ai/leak.txt", result.stderr)
                self.assertNotIn(example, result.stdout + result.stderr)
                self.assertFalse(self.public.exists())

    def test_file_names_are_checked_too(self):
        self.put("ai/internal-only-marker.txt", "safe contents\n")
        self.commit(self.private)
        self.assertNotEqual(self.sync(check=False).returncode, 0)
        self.assertFalse(self.public.exists())

    def test_missing_empty_and_invalid_committed_deny_lists_abort(self):
        for rules in (None, "# comments only\n", "[invalid regex\n"):
            with self.subTest(rules=rules):
                path = self.private / "ai/work/public-deny.txt"
                if rules is None:
                    path.unlink()
                else:
                    path.write_text(rules)
                self.commit(self.private)
                self.assertNotEqual(self.sync(check=False).returncode, 0)
                self.assertFalse(self.public.exists())

    def test_uncommitted_deny_change_cannot_disable_protection(self):
        self.put("ai/leak.txt", "internal-only-marker\n")
        self.commit(self.private)
        self.put("ai/work/public-deny.txt", "harmless-unrelated-rule\n")
        self.assertNotEqual(self.sync(check=False).returncode, 0)

    def test_symlink_cannot_escape_snapshot(self):
        (self.private / "ai/private-link").symlink_to("work/private.txt")
        self.commit(self.private)
        result = self.sync(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlinks", result.stderr)

    def test_deletions_propagate_and_second_sync_is_noop(self):
        self.put("ai/obsolete.txt", "remove me\n")
        self.commit(self.private)
        self.sync()
        (self.private / "ai/obsolete.txt").unlink()
        self.commit(self.private)
        self.sync()
        self.assertFalse((self.public / "ai/obsolete.txt").exists())
        before = self.remote_head()
        self.assertIn("already up to date", self.sync().stdout)
        self.assertEqual(before, self.remote_head())

    def test_unrelated_scratch_repo_is_left_untouched(self):
        self.command("git", "clone", "-q", str(self.remote), str(self.public))
        marker = self.public / "local-work.txt"
        marker.write_text("keep this")
        result = self.sync(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unexpected origin", result.stderr)
        self.assertEqual(marker.read_text(), "keep this")

    def test_unknown_option_is_rejected(self):
        self.assertEqual(self.sync("--dry-ru", check=False).returncode, 2)
        self.assertFalse(self.public.exists())


if __name__ == "__main__":
    unittest.main()
