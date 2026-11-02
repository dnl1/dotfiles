"""Exercise the ub-mode installer offline through its command-line entrypoint."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
NAMES = ("ub-mode", "crapper", "dryer", "mutator", "uml-viewer")


class UbModeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ub-mode test ")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.source = self.home / "checkout/ai/ub-mode"
        if (ROOT / "ai/ub-mode").exists():
            shutil.copytree(ROOT / "ai/ub-mode", self.source)
        else:
            self.source.mkdir(parents=True)
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "GIT_CONFIG_GLOBAL": str(self.home / ".gitconfig"),
            "GIT_CONFIG_NOSYSTEM": "1",
            "UB_MODE_WITH_UML_VIEWER": "0",
        }
        self.repos = self.home / "repos"
        self.repos.mkdir()
        self.git("config", "--global", f"url.{self.repos.as_uri()}/.insteadOf",
                 "https://github.com/unclebob/")
        self.revisions = {}
        for name in NAMES:
            repo = self.repos / f"{name}.git"
            self.git("init", "-q", str(repo))
            (repo / "SKILL.md").write_text(f"# {name}\n")
            self.git("-C", str(repo), "add", ".")
            self.git("-C", str(repo), "-c", "user.name=Test", "-c",
                     "user.email=test@example.invalid", "commit", "-qm", "fixture")
            self.revisions[name] = self.git("-C", str(repo), "rev-parse", "HEAD").stdout.strip()
        self.write_revisions()
        uv = self.bin / "uv"
        uv.write_text(f"#!{sys.executable}\n" + '''import json, os
from pathlib import Path
import sys
home = Path(os.environ["HOME"])
args = sys.argv[1:]
with (home / "uv-calls.jsonl").open("a") as log:
    log.write(json.dumps(args) + "\\n")
assert args[:2] == ["tool", "install"], args
name = Path(args[-1]).name
binary = home / ".local/bin" / name
binary.parent.mkdir(parents=True, exist_ok=True)
binary.write_text("#!/bin/sh\\nprintf '%s\\\\n' " + name + "\\n")
binary.chmod(0o755)
''')
        uv.chmod(0o755)
        self.base = self.home / ".local/share/ub-mode"

    def git(self, *args):
        return subprocess.run(["git", *args], env=self.env, text=True,
                              capture_output=True, check=True, timeout=10)

    def write_revisions(self):
        (self.source / "revisions.tsv").write_text("".join(
            f"{name}\t{revision}\n" for name, revision in self.revisions.items()))

    def install(self):
        return subprocess.run(["/bin/bash", str(self.source / "install.sh")],
                              cwd=self.home, env=self.env, text=True,
                              capture_output=True, timeout=20)

    def calls(self):
        return [json.loads(line) for line in
                (self.home / "uv-calls.jsonl").read_text().splitlines()]

    def test_installs_pinned_skill_and_python_tools_without_launching_viewer(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        skill = self.home / ".claude/skills/ub-mode"
        self.assertTrue(skill.is_symlink())
        self.assertEqual(skill.resolve(), self.base / "ub-mode")
        for name in NAMES[:-1]:
            self.assertEqual(self.git("-C", str(self.base / name), "rev-parse", "HEAD").stdout.strip(),
                             self.revisions[name])
        self.assertEqual([Path(call[-1]).name for call in self.calls()],
                         ["crapper", "dryer", "mutator"])
        for call in self.calls():
            self.assertIn("--no-python-downloads", call)
            self.assertEqual(call[call.index("--python") + 1], ">=3.11")
        mutator = self.calls()[-1]
        self.assertEqual(mutator[mutator.index("--with") + 1], str(self.base / "crapper"))
        for name in ("crapper", "dryer", "mutator"):
            binary = self.home / ".local/bin" / name
            self.assertTrue(os.access(binary, os.X_OK))
        self.assertFalse((self.base / "uml-viewer").exists())
        self.assertFalse((self.home / ".local/bin/uml-viewer").exists())

    def test_finds_freshly_installed_uv_before_shell_path_is_reloaded(self):
        local_bin = self.home / ".local/bin"
        local_bin.mkdir(parents=True)
        shutil.move(str(self.bin / "uv"), local_bin / "uv")
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls()), 3)

    def test_rerun_works_offline_without_reinstalling_tools(self):
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        calls = self.calls()
        binary = self.home / ".local/bin/mutator"
        modified = binary.stat().st_mtime_ns
        self.repos.rename(self.home / "offline")
        second = self.install()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.calls(), calls)
        self.assertEqual(binary.stat().st_mtime_ns, modified)

    def test_existing_custom_skill_is_left_untouched(self):
        skill = self.home / ".claude/skills/ub-mode"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("My local instructions\n")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((skill / "SKILL.md").read_text(), "My local instructions\n")
        self.assertEqual(list(skill.iterdir()), [skill / "SKILL.md"])

    def test_new_crapper_pin_updates_crapper_and_mutator_together(self):
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        repo = self.repos / "crapper.git"
        (repo / "SKILL.md").write_text("Updated upstream\n")
        self.git("-C", str(repo), "-c", "user.name=Test", "-c",
                 "user.email=test@example.invalid", "commit", "-qam", "update")
        revision = self.git("-C", str(repo), "rev-parse", "HEAD").stdout.strip()
        self.revisions["crapper"] = revision
        self.write_revisions()
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("-C", str(self.base / "crapper"), "rev-parse", "HEAD").stdout.strip(),
                         revision)
        self.assertEqual([Path(call[-1]).name for call in self.calls()],
                         ["crapper", "dryer", "mutator", "crapper", "mutator"])

    def test_modified_checkout_is_not_installed_or_overwritten(self):
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        source = self.base / "crapper/SKILL.md"
        source.write_text("Local work\n")
        calls = self.calls()
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(source.read_text(), "Local work\n")
        self.assertEqual(self.calls(), calls)

    def test_existing_unmanaged_viewer_launcher_is_left_untouched(self):
        self.env["UB_MODE_WITH_UML_VIEWER"] = "1"
        launcher = self.home / ".local/bin/uml-viewer"
        launcher.parent.mkdir(parents=True)
        original = self.home / "my-viewer"
        original.write_text("My custom launcher\n")
        for symlink in (False, True):
            with self.subTest(symlink=symlink):
                launcher.unlink(missing_ok=True)
                if symlink:
                    launcher.symlink_to(original)
                else:
                    launcher.write_text(original.read_text())
                result = self.install()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(launcher.is_symlink(), symlink)
                self.assertEqual(launcher.read_text(), "My custom launcher\n")
                self.assertEqual(original.read_text(), "My custom launcher\n")
                launcher.unlink()

    def test_viewer_is_opt_in_and_bootstrap_does_not_start_it(self):
        clojure = self.bin / "clojure"
        clojure.write_text(f"#!{sys.executable}\n" + '''import json, os, sys
from pathlib import Path
Path(os.environ["HOME"], "clojure-call.json").write_text(json.dumps(sys.argv[1:]))
''')
        clojure.chmod(0o755)
        self.env["UB_MODE_WITH_UML_VIEWER"] = "1"
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        launcher = self.home / ".local/bin/uml-viewer"
        self.assertTrue(os.access(launcher, os.X_OK))
        self.assertEqual(self.git("-C", str(self.base / "uml-viewer"), "rev-parse", "HEAD").stdout.strip(),
                         self.revisions["uml-viewer"])
        log = self.home / "clojure-call.json"
        self.assertFalse(log.exists(), "installation must not start Clojure or the viewer")
        launched = subprocess.run([str(launcher), "my diagram.edn"], cwd=self.home,
                                  env=self.env, text=True, capture_output=True, timeout=10)
        self.assertEqual(launched.returncode, 0, launched.stderr)
        args = json.loads(log.read_text())
        self.assertIn(f':local/root "{self.base}/uml-viewer"', args[args.index("-Sdeps") + 1])
        self.assertEqual(args[-3:], ["-m", "uml-viewer.main.uml-viewer", "my diagram.edn"])

        local_clojure = self.base / "runtime/clojure/bin/clojure"
        local_clojure.parent.mkdir(parents=True)
        local_clojure.write_text(f"#!{sys.executable}\n" + '''import os
from pathlib import Path
Path(os.environ["HOME"], "local-runtime-used").write_text(os.environ["JAVA_HOME"])
''')
        local_clojure.chmod(0o755)
        java = self.base / "runtime/java/bin/java"
        java.parent.mkdir(parents=True)
        java.touch(mode=0o755)
        launched = subprocess.run([str(launcher), "--help"], cwd=self.home,
                                  env=self.env, text=True, capture_output=True, timeout=10)
        self.assertEqual(launched.returncode, 0, launched.stderr)
        self.assertEqual((self.home / "local-runtime-used").read_text(), str(java.parent.parent))

        launcher.write_text(launcher.read_text() + "# previous managed version\n")
        rerun = self.install()
        self.assertEqual(rerun.returncode, 0, rerun.stderr)
        self.assertEqual(launcher.read_text(), (self.source / "uml-viewer").read_text())
        self.assertEqual(len(self.calls()), 3)

    def test_bootstrap_calls_installer_after_uv(self):
        bootstrap = (ROOT / "ai/bootstrap.sh").read_text()
        start = bootstrap.find('step "ub-mode"\n')
        self.assertGreater(start, bootstrap.index('step "uv"\n'))
        block = bootstrap[start:].split("# ──", 1)[0]
        result = subprocess.run(["/bin/bash", "-c",
                                 'set -euo pipefail\nstep() { :; }; ok() { :; };\n' + block],
                                env={**self.env, "AI_DIR": str(self.source.parent)},
                                text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.home / ".claude/skills/ub-mode").is_symlink())
        self.assertEqual(len(self.calls()), 3)


if __name__ == "__main__":
    unittest.main()
