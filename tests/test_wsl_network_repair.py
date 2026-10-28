"""Exercise WSL configuration writes only in a temporary directory."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class WslNetworkRepairTests(unittest.TestCase):
    def test_uses_sudo_account_and_refuses_missing_or_root_accounts(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            config = base / "wsl.conf"
            resolver = base / "resolv.conf"
            script = base / "repair.sh"
            script.write_text((ROOT / "repair-wsl-network.sh").read_text()
                              .replace("/etc/wsl.conf", str(config))
                              .replace("/etc/resolv.conf", str(resolver)))
            identity = base / "id"
            identity.write_text('#!/bin/sh\n'
                                'if [ "$1" = -u ]; then echo 0; '
                                'elif [ "$1" = regular-user ]; then exit 0; '
                                'else exit 1; fi\n')
            identity.chmod(0o755)
            for account in ("regular-user", "root", "", "missing-user"):
                with self.subTest(account=account):
                    config.write_text("original config\n")
                    resolver.write_text("original resolver\n")
                    env = {**os.environ, "PATH": f"{base}:{os.environ['PATH']}",
                           "SUDO_USER": account}
                    result = subprocess.run(["bash", str(script)], env=env,
                                            capture_output=True, text=True, timeout=5)
                    if account == "regular-user":
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertIn("default=regular-user\n", config.read_text())
                        self.assertFalse(resolver.exists())
                    else:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertEqual(config.read_text(), "original config\n")
                        self.assertTrue(resolver.exists())


if __name__ == "__main__":
    unittest.main()
