"""Exercise Pi's real jail preset with synthetic state and a captured terminal."""

import fcntl
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP = (ROOT / "ai/bootstrap.sh").read_text()
RENDER = re.search(r'rendered="\$\((python3 - .*?)\n\)"', BOOTSTRAP, re.S).group(1)


class PiJailTests(unittest.TestCase):
    def test_both_platforms_keep_pi_resources_and_terminal_support(self):
        for platform in ("Linux", "Darwin"):
            with self.subTest(platform=platform):
                text = (ROOT / f"ai/ai-jail/{platform}.toml").read_text()
                config = tomllib.loads(text.replace("__ENV_FROM_FILE__", ""))["commands"]["pi"]
                self.assertIn("__AI_DIR__/pi", config["ro_maps"])
                self.assertIn("__HOME__/.local/share/claude", config["ro_maps"])
                for path in (".claude", ".claude.json", ".claude-pessoal", ".codex"):
                    self.assertIn(f"__HOME__/{path}", config["rw_maps"])
                self.assertTrue(config["terminal_passthrough"])
                self.assertTrue(config["no_status_bar"])
                self.assertIn("HERDR_PANE_ID", config["env_pass"])
                self.assertIn("PI_CLIPBOARD_OSC52", config["env_pass"])
                self.assertIn("PI_JAILED=1", config["env_pass"])
                self.assertFalse(config.get("inherit_env", False))
                self.assertIn("__DOTFILES__/openbao", config["ro_maps"])
                # ai-jail ignores `worktree`; only `no_worktree = false` exposes a linked worktree.
                presets = tomllib.loads(text.replace("__ENV_FROM_FILE__", ""))["commands"]
                for preset in presets.values():
                    self.assertIs(preset.get("no_worktree"), False)
                    self.assertNotIn("worktree", preset)
                if platform == "Linux":
                    self.assertIn("__HOME__/.config/ai-jail/hosts:/etc/hosts", config["ro_maps"])
                    self.assertIn("__RUNTIME_DIR__/moshi-hook.sock", config["ro_maps"])

    @unittest.skipUnless(sys.platform == "linux" and shutil.which("ai-jail") and shutil.which("bwrap"),
                         "requires Linux, ai-jail and bubblewrap")
    def test_real_direct_pi_preset_preserves_terminal_and_shared_state(self):
        jail = shutil.which("ai-jail")
        with tempfile.TemporaryDirectory(prefix="pi-jail-") as directory:
            base = Path(directory).resolve()
            home, ai, project = base / "home", base / "checkout with spaces/ai", base / "project"
            agent = home / ".pi/agent"
            for path in (agent / "extensions", home / ".local/bin", ai / "pi/lib", ai / "pi/extensions", project):
                path.mkdir(parents=True, exist_ok=True)
            shutil.copytree(ROOT / "ai/ai-jail", ai / "ai-jail")
            for name in ("statusline", "herdr-clipboard"):
                (ai / f"pi/extensions/{name}.ts").write_text("synthetic-extension\n")
                (agent / f"extensions/{name}.ts").symlink_to(ai / f"pi/extensions/{name}.ts")
            (ai / "pi/lib/model-status.ts").write_text("synthetic-helper\n")
            (agent / "lib").symlink_to(ai / "pi/lib")
            auth_paths = (".pi/agent/auth.json", ".claude/.credentials.json", ".claude.json",
                          ".claude-pessoal/.credentials.json", ".codex/auth.json")
            for path in auth_paths:
                file = home / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("synthetic-auth\n")
            claude = home / ".local/share/claude/versions/qa"
            claude.parent.mkdir(parents=True)
            claude.write_text("#!/bin/sh\nexit 0\n")
            claude.chmod(0o755)
            (home / ".local/bin/claude").symlink_to(claude)
            probe = home / ".local/bin/pi"
            probe.write_text("""#!/bin/sh
set -eu
for file in extensions/statusline.ts extensions/herdr-clipboard.ts lib/model-status.ts; do
  test -r "$HOME/.pi/agent/$file"
done
for file in .pi/agent/auth.json .claude/.credentials.json .claude.json .claude-pessoal/.credentials.json .codex/auth.json; do
  test -r "$HOME/$file"
  if [ "$file" = .claude.json ]; then
    printf 'synthetic-refreshed' > "$HOME/$file"
  else
    printf 'synthetic-refreshed' > "$HOME/$file.tmp"
    mv "$HOME/$file.tmp" "$HOME/$file"
  fi
done
claude --version
test "$HERDR_PANE_ID" = qa-pane
test "$PI_CLIPBOARD_OSC52" = 0
test "$PI_JAILED" = 1
printf '\\033[?1049h\\033[?1000h\\033[?1006h'
printf '\\033]52;c;cGktamFpbC1xYQ==\\007'
sleep 0.1
printf '\\033[?1049l'
""")
            probe.chmod(0o755)
            env = {"HOME": str(home), "PATH": f"{home}/.local/bin:/usr/bin:/bin", "TERM": "xterm-256color",
                   "HERDR_PANE_ID": "qa-pane", "PI_CLIPBOARD_OSC52": "0", "AI_DIR": str(ai), "OS": "Linux",
                   "env_line": ""}
            rendered = subprocess.run(["bash", "-c", RENDER], env=env, capture_output=True,
                                      text=True, check=True, timeout=10).stdout
            (home / ".ai-jail").write_text(rendered)
            master, slave = pty.openpty()
            try:
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
                with subprocess.Popen([jail, "--exec", "pi"], env=env, cwd=project,
                                      stdin=slave, stdout=slave, stderr=slave) as child:
                    os.close(slave)
                    slave = None
                    data = b""
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        if select.select([master], [], [], 0.1)[0]:
                            try:
                                chunk = os.read(master, 65536)
                            except OSError:
                                break
                            if not chunk:
                                break
                            data += chunk
                        elif child.poll() is not None:
                            break
                    if child.poll() is None:
                        child.kill()
                    self.assertEqual(child.wait(), 0, "Pi resources, provider logins or terminal support are missing")
                    self.assertIn(b"\x1b]52;c;cGktamFpbC1xYQ==\x07", data)
                    self.assertIn(b"\x1b[?1006h", data)
                    self.assertIn(b"\x1b[?1049h", data)
                    self.assertIn(b"\x1b[?1049l", data)
                    for path in auth_paths:
                        self.assertEqual((home / path).read_text(), "synthetic-refreshed")
            finally:
                if slave is not None:
                    os.close(slave)
                os.close(master)


if __name__ == "__main__":
    unittest.main()
