"""Tests without real apps, an Ollama server, or changes to the user directory."""

from contextlib import ExitStack, redirect_stdout
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import io
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "ai/bin/llm-mode"
LOADER = SourceFileLoader("llm_mode", str(SOURCE))
MODULE = module_from_spec(spec_from_loader(LOADER.name, LOADER))
LOADER.exec_module(MODULE)
m = MODULE
BRAVE = {"id": "com.brave.Browser", "name": "Brave Browser", "pid": 123}
SLACK = {"id": "com.tinyspeck.slackmacgap", "name": "Slack", "pid": 456}
TERMINAL = {"id": "com.apple.Terminal", "name": "Terminal", "pid": 789}


class ModeTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        for key, value in {
            "HOME": self.home,
            "CONFIG": self.home / ".config/ai/llm-mode.json",
            "STATE_DIR": self.home / ".local/state/llm-mode",
            "STATE": self.home / ".local/state/llm-mode/session.json",
            "PLIST": self.home / "Library/LaunchAgents/local.plist",
        }.items():
            self.stack.enter_context(patch.object(m, key, value))
        self.stack.enter_context(redirect_stdout(io.StringIO()))
        self.cfg = {**m.DEFAULTS, "close_apps": list(m.DEFAULTS["close_apps"])}

    def test_selection_never_includes_terminal_or_other_apps(self):
        self.assertEqual(m.candidates(self.cfg, [BRAVE, TERMINAL]), [BRAVE])

    def test_config_rejects_apps_outside_allowlist(self):
        m.write_json(m.CONFIG, {"close_apps": ["com.apple.Terminal"]})
        with self.assertRaisesRegex(RuntimeError, "only allows Brave"):
            m.config()

    def test_config_rejects_unbounded_context_and_modelfile_injection(self):
        for cfg in ({"context": 262144}, {"source_model": "devstral\nPARAMETER num_ctx 262144"},
                    {"max_output": 16384}, {"context": "16384"}):
            m.write_json(m.CONFIG, cfg)
            with self.assertRaises(RuntimeError):
                m.config()

    @patch.object(m.shutil, "which", return_value="/opt/homebrew/bin/ollama")
    @patch.object(m, "service_loaded", return_value=False)
    def test_configuration_is_local_bounded_and_does_not_autostart(self, *_):
        path = self.home / ".pi/agent/models.json"
        unrelated = {"baseUrl": "http://another-local-server", "models": [{"id": "existing"}]}
        m.write_json(path, {"providers": {"existing": unrelated}})
        settings_path = self.home / ".pi/agent/settings.json"
        m.write_json(settings_path, {"defaultProvider": "claude-bridge", "compaction": {
            "reserveTokens": 12000, "modelOverrides": {"other/model": {"reserveTokens": 1000}},
        }})
        auto_path = self.home / ".pi/agent/auto-model.json"
        opus = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        rules = [{"name": "opus-default", "when": {"trigger": "user"}, "then": {"exclude": ["ollama-local/*"]}}]
        m.write_json(auto_path, {"pool": "general", "rules": rules,
                                 "pricing": {"overrides": {"claude-bridge/claude-opus-5-5": opus}}})
        m.configure(self.cfg)
        definition = plistlib.loads(m.PLIST.read_bytes())
        env = definition["EnvironmentVariables"]
        self.assertFalse(definition["RunAtLoad"])
        self.assertEqual(env["OLLAMA_HOST"], "127.0.0.1:11434")
        self.assertEqual(env["OLLAMA_NO_CLOUD"], "1")
        self.assertEqual(env["OLLAMA_NUM_PARALLEL"], "1")
        self.assertEqual(env["OLLAMA_MAX_LOADED_MODELS"], "1")
        self.assertEqual(env["OLLAMA_KV_CACHE_TYPE"], "q8_0")
        providers = m.read_json(path, {})["providers"]
        self.assertEqual(providers["existing"], unrelated)
        model = providers[m.PROVIDER]["models"][0]
        self.assertEqual(model["contextWindow"], 16384)
        self.assertEqual(model["maxTokens"], 4096)
        self.assertTrue(all(cost == 0 for cost in model["cost"].values()))
        settings = m.read_json(settings_path, {})
        self.assertEqual(settings["defaultProvider"], "claude-bridge")
        self.assertEqual(settings["compaction"]["reserveTokens"], 12000)
        self.assertEqual(settings["compaction"]["modelOverrides"]["other/model"], {"reserveTokens": 1000})
        self.assertEqual(settings["compaction"]["modelOverrides"]["ollama-local/devstral-local"], {
            "reserveTokens": 4096, "keepRecentTokens": 4096,
        })
        auto = m.read_json(auto_path, {})
        self.assertEqual(auto["pool"], "general")
        self.assertEqual(auto["rules"], rules)
        self.assertEqual(auto["scenarios"], {"background": {"prefer": ["ollama-local/devstral-local"]}})
        self.assertEqual(auto["pricing"]["overrides"]["claude-bridge/claude-opus-5-5"], opus)
        self.assertEqual(auto["pricing"]["overrides"]["ollama-local/devstral-local"], opus)
        before = path.read_bytes()
        auto_before = auto_path.read_bytes()
        m.configure(self.cfg)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(auto_path.read_bytes(), auto_before)
        self.assertEqual(len(list(path.parent.glob("models.json.bak-*"))), 1)
        self.assertEqual(len(list(path.parent.glob("auto-model.json.bak-*"))), 1)

    @patch.object(m, "service_loaded", return_value=False)
    @patch.object(m, "server_alive", return_value=True)
    @patch.object(m, "run")
    def test_unmanaged_server_is_not_reconfigured(self, run, *_):
        with self.assertRaisesRegex(RuntimeError, "Another Ollama"):
            m.start_server(self.cfg)
        run.assert_not_called()

    @patch.object(m, "start_server")
    @patch.object(m, "run")
    def test_prepare_pins_localhost_and_context(self, run, *_):
        contents = []

        def inspect(args, **kwargs):
            self.assertEqual(kwargs["env"]["OLLAMA_HOST"], "127.0.0.1:11434")
            if args[1] == "create":
                contents.append(Path(args[-1]).read_text())

        run.side_effect = inspect
        with patch.dict(m.os.environ, {"OLLAMA_HOST": "http://unrelated-server"}):
            m.prepare(self.cfg)
        self.assertIn("PARAMETER num_ctx 16384", contents[0])
        self.assertIn("PARAMETER num_predict 4096", contents[0])

    def enter_patches(self, running):
        self.stack.enter_context(patch.object(m, "start_server"))
        self.stack.enter_context(patch.object(m, "api", return_value={"models": [{"name": "devstral-local:latest"}]}))
        self.stack.enter_context(patch.object(m, "apps", side_effect=running))
        self.stack.enter_context(patch.object(m.time, "sleep"))
        return self.stack.enter_context(patch.object(m, "run"))

    def test_enter_records_only_selected_apps_and_uses_normal_quit(self):
        run = self.enter_patches([[BRAVE, TERMINAL], [TERMINAL]])
        m.enter(self.cfg, yes=True)
        state = m.read_json(m.STATE, {})
        self.assertEqual(state["apps"], [BRAVE])
        self.assertEqual(state["phase"], "active")
        command = run.call_args.args[0]
        self.assertEqual(json.loads(command[-1]), [BRAVE["id"]])
        self.assertIn("a.terminate;", command[-2])
        self.assertNotIn("forceTerminate", command[-2])

    def test_enter_without_confirmation_closes_nothing(self):
        run = self.enter_patches([[BRAVE]])
        with patch.object(m.sys.stdin, "isatty", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "Cancelled"):
                m.enter(self.cfg)
        run.assert_not_called()
        self.assertFalse(m.STATE.exists())

    def test_keep_apps_is_non_disruptive(self):
        run = self.enter_patches([])
        m.enter(self.cfg, keep_apps=True)
        run.assert_not_called()
        self.assertEqual(m.read_json(m.STATE, {})["apps"], [])

    def test_refused_quit_keeps_recovery_state_without_force(self):
        self.enter_patches([[BRAVE]] * 41)
        with self.assertRaisesRegex(RuntimeError, "waiting for quit confirmation"):
            m.enter(self.cfg, yes=True)
        self.assertEqual(m.read_json(m.STATE, {})["phase"], "entering")

    @patch.object(m, "service_loaded", return_value=False)
    @patch.object(m, "apps", return_value=[BRAVE, TERMINAL])
    @patch.object(m, "run")
    def test_leave_reopens_only_apps_it_closed(self, run, *_):
        m.write_json(m.STATE, {"apps": [BRAVE, SLACK], "phase": "active"})
        m.leave()
        run.assert_called_once_with(["open", "-g", "-b", SLACK["id"]])
        self.assertFalse(m.STATE.exists())

    @patch.object(m, "service_loaded", return_value=False)
    @patch.object(m, "apps", return_value=[])
    @patch.object(m, "run", side_effect=subprocess.CalledProcessError(1, "open"))
    def test_failed_reopen_remains_retryable(self, *_):
        m.write_json(m.STATE, {"apps": [SLACK], "phase": "active"})
        with self.assertRaisesRegex(RuntimeError, "could not be reopened"):
            m.leave()
        self.assertEqual(m.read_json(m.STATE, {})["apps"], [SLACK])

    @patch.object(m, "service_loaded", return_value=True)
    @patch.object(m, "server_alive", return_value=False)
    @patch.object(m, "run")
    def test_leave_stops_only_the_owned_service(self, run, *_):
        m.leave()
        run.assert_called_once_with(["launchctl", "bootout", f"{m.DOMAIN}/{m.LABEL}"])

    @patch.object(m.sys, "platform", "darwin")
    @patch.object(m.sys, "argv", ["llm-mode", "code"])
    @patch.object(m.subprocess, "call", return_value=0)
    @patch.object(m, "start_server")
    def test_code_restarts_owned_server_after_idle_or_reboot(self, start, call):
        m.write_json(m.STATE, {"apps": [], "phase": "active"})
        self.assertEqual(m.main(), 0)
        start.assert_called_once()
        call.assert_called_once()

    @patch.object(m.sys, "platform", "darwin")
    @patch.object(m.sys, "argv", ["llm-mode", "code"])
    @patch.object(m.subprocess, "call")
    def test_incomplete_entry_cannot_start_coding(self, call):
        m.write_json(m.STATE, {"apps": [BRAVE], "phase": "entering"})
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            m.main()
        call.assert_not_called()

    def test_cloud_return_is_explicit_and_loads_only_required_extensions(self):
        package = self.home / ".pi/agent/npm/node_modules/pi-claude-bridge"
        m.write_json(package / "package.json", {"pi": {"extensions": ["./src/index.ts"]}})
        entry = package / "src/index.ts"
        entry.parent.mkdir()
        entry.touch()
        command = m.code_command(self.cfg, [], wait_claude=True)
        self.assertIn("--no-extensions", command)
        self.assertIn("--wait-claude", command)
        self.assertIn(str(entry.resolve()), command)
        self.assertEqual(command.count("-e"), 2)
        self.assertEqual(command[command.index("--usage-fallback") + 1], "ollama-local/devstral-local")
        self.assertIn("claude-bridge/*", command[command.index("--models") + 1])

    def test_cloud_return_requires_the_provider_package(self):
        with self.assertRaisesRegex(RuntimeError, "pi-claude-bridge"):
            m.code_command(self.cfg, [], wait_claude=True)

    def test_provider_entry_cannot_escape_its_package(self):
        package = self.home / ".pi/agent/npm/node_modules/pi-claude-bridge"
        m.write_json(package / "package.json", {"pi": {"extensions": ["../outside.ts"]}})
        with self.assertRaisesRegex(RuntimeError, "Invalid entry point"):
            m.code_command(self.cfg, [], wait_claude=True)

    def test_coding_profile_has_no_cloud_extensions_or_mcp(self):
        command = m.code_command(self.cfg, ["--print", "task"])
        for flag in ("--no-extensions", "--no-mcp", "--no-skills", "--offline"):
            self.assertIn(flag, command)
        self.assertEqual(command[command.index("--provider") + 1], "ollama-local")
        self.assertEqual(command[command.index("--model") + 1], "devstral-local")
        self.assertEqual(command[-2:], ["--print", "task"])


if __name__ == "__main__":
    unittest.main()
