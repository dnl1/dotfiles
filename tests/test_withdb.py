import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest


HELPER = Path(__file__).resolve().parents[1] / "ai/shell/dbcreds.zsh"


@unittest.skipUnless(shutil.which("zsh") and shutil.which("jq"), "requires zsh and jq")
class WithdbTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.bin = self.home / "bin"
        self.bin.mkdir()
        for name in ("jq", "python3"):
            (self.bin / name).symlink_to(shutil.which(name))
        self.bao = self.bin / "bao"
        self.bao.write_text(
            "#!" + shutil.which("python3") + "\n"
            "import json, os, sys\n"
            "from pathlib import Path\n"
            "Path(os.environ['BAO_CALL']).write_text(json.dumps({\n"
            "  'args': sys.argv[1:], 'timeout': os.environ.get('BAO_CLIENT_TIMEOUT'),\n"
            "  'retries': os.environ.get('BAO_MAX_RETRIES'),\n"
            "  'address': os.environ.get('BAO_ADDR'), 'ca': os.environ.get('BAO_CACERT'),\n"
            "  'godebug': os.environ.get('GODEBUG')}))\n"
            "settings = dict(item.split('=', 1) for item in os.environ.get('GODEBUG', '').split(',') if '=' in item)\n"
            "if os.environ.get('REQUIRE_GO_DNS') == '1' and settings.get('netdns') != 'go': sys.exit(1)\n"
            "sys.stderr.write('provider error must stay hidden')\n"
            "print(os.environ.get('FAKE_BAO_JSON', ''))\n"
            "sys.exit(int(os.environ.get('FAKE_BAO_EXIT', '0')))\n"
        )
        self.bao.chmod(0o755)
        self.store = self.home / ".config/dbcreds/db.json.gpg"
        self.store.parent.mkdir(parents=True)
        self.store.touch()
        self.env = {
            "HOME": str(self.home), "PATH": str(self.bin),
            "BAO_CALL": str(self.home / "bao-call"),
            "GPG_CALL": str(self.home / "gpg-call"),
            "FAKE_BAO_JSON": json.dumps({"data": {"data": {"DATABASE_URL": "mysql://vault.example/test"}}}),
            "FAKE_GPG_JSON": json.dumps({"prod": "mysql://fallback.example/test", "stage": "mysql://stage.example/test"}),
        }
        self.zsh = shutil.which("zsh")

    def run_withdb(self, target="prod", expected="mysql://vault.example/test", exit_code=0, os_type=None):
        script = f"source {shlex.quote(str(HELPER))}\n" + '''
_dbcreds_gpg() {
  print used > "$GPG_CALL"
  [[ ${FAKE_GPG_FAIL:-0} == 0 ]] || return 1
  print -r -- "$FAKE_GPG_JSON"
}
'''
        child = (
            "import os, sys; "
            f"assert os.environ['DATABASE_URL'] == {expected!r}; "
            f"assert os.environ['DATABASE_URL_{target.upper()}'] == {expected!r}; "
            f"assert os.environ.get('GODEBUG') == {self.env.get('GODEBUG')!r}; "
            f"print('child-ran'); sys.exit({exit_code})"
        )
        if os_type is not None:
            script += f"OSTYPE={shlex.quote(os_type)}\n"
        script += f"withdb {shlex.quote(target)} python3 -c {shlex.quote(child)}\n"
        return subprocess.run([self.zsh, "-f"], input=script, text=True,
                              env=self.env, capture_output=True)

    def test_openbao_first_without_local_store(self):
        self.store.unlink()
        result = self.run_withdb()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "child-ran\n")
        self.assertEqual(result.stderr, "")
        self.assertFalse((self.home / "gpg-call").exists())
        call = json.loads((self.home / "bao-call").read_text())
        self.assertEqual(call["args"], ["kv", "get", "-format=json", "kv/databases/production"])
        self.assertEqual(call["timeout"], "5s")
        self.assertEqual(call["retries"], "0")
        self.assertEqual(call["address"], "https://openbao.local")

    def test_mac_go_dns_prevents_false_gpg_fallback_without_affecting_child(self):
        self.env.update(REQUIRE_GO_DNS="1", GODEBUG="http2client=0,netdns=cgo")
        result = self.run_withdb(os_type="darwin25")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "child-ran\n")
        self.assertEqual(result.stderr, "")
        self.assertFalse((self.home / "gpg-call").exists())
        call = json.loads((self.home / "bao-call").read_text())
        self.assertIn("http2client=0", call["godebug"])

    def test_linux_keeps_existing_dns_behavior(self):
        for existing in (None, "netdns=cgo,http2client=0"):
            with self.subTest(existing=existing):
                if existing is None:
                    self.env.pop("GODEBUG", None)
                else:
                    self.env["GODEBUG"] = existing
                result = self.run_withdb(os_type="linux-gnu")
                self.assertEqual(result.returncode, 0, result.stderr)
                call = json.loads((self.home / "bao-call").read_text())
                self.assertEqual(call["godebug"], existing)

    def test_v1_secret_and_stage_mapping(self):
        self.env["FAKE_BAO_JSON"] = json.dumps({"data": {"DATABASE_URL": "mysql://vault.example/test"}})
        self.env["DBCREDS_OPENBAO_PREFIX"] = "custom/databases"
        self.env["BAO_ADDR"] = "https://vault.example"
        ca = self.home / ".config/openbao/openbao-local-ca.crt"
        ca.parent.mkdir(parents=True)
        ca.touch()
        result = self.run_withdb(target="stage")
        self.assertEqual(result.returncode, 0, result.stderr)
        call = json.loads((self.home / "bao-call").read_text())
        self.assertEqual(call["args"][-1], "custom/databases/staging")
        self.assertEqual(call["address"], "https://vault.example")
        self.assertEqual(call["ca"], str(ca))

    def test_explicit_ca_is_preserved(self):
        self.env["BAO_CACERT"] = "/custom/ca.pem"
        self.assertEqual(self.run_withdb().returncode, 0)
        call = json.loads((self.home / "bao-call").read_text())
        self.assertEqual(call["ca"], "/custom/ca.pem")

    def test_local_settings_preserve_custom_target_mapping(self):
        self.store.unlink()
        store = self.home / "private database" / "db.json.gpg"
        store.parent.mkdir()
        store.touch()
        (self.home / ".config/dbcreds/config.zsh").write_text(
            f"export DBCREDS_STORE={shlex.quote(str(store))}\n"
            "export DBCREDS_OPENBAO_PREFIX=kv/custom-project\n"
        )
        self.assertEqual(self.run_withdb().returncode, 0)
        call = json.loads((self.home / "bao-call").read_text())
        self.assertEqual(call["args"][-1], "kv/custom-project/production")
        self.env["FAKE_BAO_EXIT"] = "2"
        result = self.run_withdb(expected="mysql://fallback.example/test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.home / "gpg-call").exists())

    def test_provider_failure_uses_gpg(self):
        self.env["FAKE_BAO_EXIT"] = "2"
        self.env["FAKE_BAO_JSON"] = ""
        result = self.run_withdb(expected="mysql://fallback.example/test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.home / "gpg-call").exists())
        self.assertIn("trying local GPG store", result.stderr)
        self.assertNotIn("provider error", result.stderr)

    def test_provider_failure_with_output_still_uses_gpg(self):
        self.env["FAKE_BAO_EXIT"] = "2"
        result = self.run_withdb(expected="mysql://fallback.example/test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.home / "gpg-call").exists())

    def test_missing_cli_uses_gpg(self):
        self.bao.unlink()
        result = self.run_withdb(target="stage", expected="mysql://stage.example/test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.home / "bao-call").exists())

    def test_invalid_secret_uses_gpg(self):
        for value in ("not json", "{}", '{"data":{"data":{"DATABASE_URL":""}}}',
                      '{"data":{"data":{"DATABASE_URL":null}}}',
                      '{"data":{"data":{"DATABASE_URL":123}}}'):
            with self.subTest(value=value):
                self.env["FAKE_BAO_JSON"] = value
                result = self.run_withdb(expected="mysql://fallback.example/test")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("mysql://", result.stdout + result.stderr)

    def test_both_sources_fail_without_running_child(self):
        self.env["FAKE_BAO_EXIT"] = "2"
        for failure in ("missing", "decrypt", "target"):
            with self.subTest(failure=failure):
                if failure == "missing":
                    self.store.unlink()
                else:
                    self.store.touch()
                    self.env["FAKE_GPG_FAIL"] = "1" if failure == "decrypt" else "0"
                    self.env["FAKE_GPG_JSON"] = "{}"
                result = self.run_withdb()
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("child-ran", result.stdout)
                self.assertNotIn("mysql://", result.stdout + result.stderr)

    def test_successful_login_retries_openbao_before_using_gpg(self):
        access = self.bin / "openbao-access"
        access.write_text("#!" + shutil.which("python3") + "\nimport os\nfrom pathlib import Path\nPath(os.environ['HOME'], 'logged-in').touch()\n")
        access.chmod(0o755)
        self.bao.write_text("#!" + shutil.which("python3") + "\nimport os, sys\nfrom pathlib import Path\nprint(os.environ['FAKE_BAO_JSON'])\nsys.exit(0 if Path(os.environ['HOME'], 'logged-in').exists() else 2)\n")
        result = self.run_withdb()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "child-ran\n")
        self.assertFalse((self.home / "gpg-call").exists())
        self.assertTrue((self.home / "logged-in").exists())

    def test_unsuccessful_login_keeps_existing_gpg_fallback(self):
        self.env["FAKE_BAO_EXIT"] = "2"
        access = self.bin / "openbao-access"
        access.write_text("#!" + shutil.which("python3") + "\nimport sys\nsys.exit(1)\n")
        access.chmod(0o755)
        result = self.run_withdb(expected="mysql://fallback.example/test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "child-ran\n")
        self.assertTrue((self.home / "gpg-call").exists())
        self.assertNotIn("mysql://", result.stdout + result.stderr)

    def test_child_failure_does_not_retry_with_gpg(self):
        result = self.run_withdb(exit_code=42)
        self.assertEqual(result.returncode, 42)
        self.assertFalse((self.home / "gpg-call").exists())

    def test_usage_does_not_query_either_source(self):
        result = subprocess.run([self.zsh, "-fc", f"source {shlex.quote(str(HELPER))}; withdb"],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.home / "bao-call").exists())
        self.assertFalse((self.home / "gpg-call").exists())


@unittest.skipUnless(shutil.which("zsh") and shutil.which("jq"), "requires zsh and jq")
class GpgPromptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.zsh = shutil.which("zsh")
        for name in ("jq", "python3", "mkdir", "chmod", "grep", "tty"):
            (self.bin / name).symlink_to(shutil.which(name))
        self.store = self.home / ".config/dbcreds/db.json.gpg"
        self.store.parent.mkdir(parents=True)
        self.store.touch()
        self.config = self.store.parent / "gnupg/gpg-agent.conf"
        self.env = {"HOME": str(self.home), "PATH": str(self.bin), "HERDR_ENV": "1"}
        self.program("pinentry-mac", "pass")
        self.program("gpgconf", "Path(os.environ['HOME'], 'reload').write_text('reloaded')")
        self.program("herdr", "Path(os.environ['HOME'], 'notification').write_text(json.dumps(sys.argv[1:]))")
        self.program("gpg", """
args = sys.argv[1:]
with open(Path(os.environ['HOME'], 'gpg-calls'), 'a') as out:
    out.write(json.dumps(args) + '\\n')
if 'error' in args and os.environ.get('CACHE_HIT') != '1':
    sys.exit(2)
if os.environ.get('CANCEL') == '1':
    sys.exit(2)
print('{"prod":"test-only-never-print-this-value"}')
""")

    def program(self, name, code):
        path = self.bin / name
        path.write_text("#!" + shutil.which("python3") + "\nimport json, os, sys\nfrom pathlib import Path\n" + code + "\n")
        path.chmod(0o755)

    def invoke(self, command="dbcreds-ls"):
        return subprocess.run([self.zsh, "-fc", f"source {shlex.quote(str(HELPER))}; {command}"],
                              env=self.env, text=True, capture_output=True)

    def test_install_adds_native_pinentry_idempotently_and_preserves_cache_settings(self):
        self.config.parent.mkdir()
        self.config.write_text("default-cache-ttl 123\nmax-cache-ttl 456\n")
        result = self.invoke("dbcreds-setup; dbcreds-setup")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), f"default-cache-ttl 123\nmax-cache-ttl 456\npinentry-program {self.bin}/pinentry-mac\n")
        self.assertTrue((self.home / "reload").exists())
        self.assertFalse((self.home / "notification").exists())

    def test_existing_custom_pinentry_is_preserved(self):
        self.config.parent.mkdir()
        self.config.write_text("pinentry-program /custom/pinentry\n")
        self.assertEqual(self.invoke("dbcreds-setup").returncode, 0)
        self.assertEqual(self.config.read_text(), "pinentry-program /custom/pinentry\n")
        self.assertFalse((self.home / "reload").exists())

    def test_locked_store_notifies_herdr_before_real_prompt_without_printing_values(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "prod\n")
        self.assertNotIn("never-print", result.stdout + result.stderr)
        notice = json.loads((self.home / "notification").read_text())
        self.assertEqual(notice[:3], ["notification", "show", "Desbloquear cofre GPG"])
        self.assertEqual(notice[-2:], ["--sound", "request"])
        calls = [json.loads(line) for line in (self.home / "gpg-calls").read_text().splitlines()]
        self.assertEqual(len(calls), 2)
        self.assertIn("error", calls[0])
        self.assertNotIn("error", calls[1])

    def test_cached_store_does_not_send_password_request(self):
        self.env["CACHE_HIT"] = "1"
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "prod\n")
        self.assertFalse((self.home / "notification").exists())

    def test_outside_herdr_does_not_touch_herdr_session(self):
        self.env.pop("HERDR_ENV")
        self.assertEqual(self.invoke().returncode, 0)
        self.assertFalse((self.home / "notification").exists())

    def test_cancelled_prompt_fails_without_printing_values(self):
        self.env["CANCEL"] = "1"
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("never-print", result.stderr)

    def test_mobile_terminal_unlock_refuses_noninteractive_agent_stdin(self):
        result = self.invoke("dbcreds-unlock --terminal")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("interactive terminal", result.stderr)
        self.assertFalse((self.home / "gpg-calls").exists())

    def test_native_unlock_reports_only_success(self):
        self.env["CACHE_HIT"] = "1"
        result = self.invoke("dbcreds-unlock")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "Cofre GPG desbloqueado.\n")
        self.assertNotIn("never-print", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
