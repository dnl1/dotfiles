"""Offline fixtures for Pi settings and compatibility-package installation."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PI = ROOT / 'ai/pi'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


settings = load('pi_settings', PI / 'apply-settings.py')
builder = load('pi_compat_installer', PI / 'routing-compat/install.py')


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.agent = self.home / '.pi/agent'
        self.config = self.home / '.config'
        (self.agent / 'packages/pi-routing-compat').mkdir(parents=True)
        (self.agent / 'packages/pi-routing-compat/entry.ts').write_text('// fixture\n')

    def apply(self):
        return settings.apply(self.agent, PI, self.config)

    def test_fresh_install_and_ponytail_off(self):
        self.apply()
        value = json.loads((self.agent / 'settings.json').read_text())
        self.assertFalse(value['contextPaging']['enabled'])
        self.assertEqual(json.loads((self.config / 'ponytail/config.json').read_text()), {'defaultMode': 'off'})
        for name in ('pi-codex-native', 'pi-auto-model', '@rochecompaan/pi-context-paging'):
            package = next(p for p in value['packages'] if isinstance(p, dict) and p['source'].startswith('npm:' + name + '@'))
            self.assertEqual(package['extensions'], [])

    def test_preserves_local_packages_and_runtime_options(self):
        current = {'packages': ['npm:personal@1.0.0', 'npm:pi-auto-model@0.8.0'], 'enabledModels': ['fixture/model'], 'compaction': {'enabled': True, 'modelOverrides': {'local/model': {'reserveTokens': 123}}}, 'lastChangelogVersion': 'fixture'}
        (self.agent / 'settings.json').write_text(json.dumps(current))
        self.apply()
        value = json.loads((self.agent / 'settings.json').read_text())
        self.assertIn('npm:personal@1.0.0', value['packages'])
        self.assertNotIn('npm:pi-auto-model@0.8.0', value['packages'])
        for key in ('enabledModels', 'compaction', 'lastChangelogVersion'):
            self.assertEqual(value[key], current[key])

    def test_scoped_and_local_package_identities(self):
        original = {'packages': ['npm:@scope/tool@1', './packages/pi-routing-compat', 'npm:custom@1']}
        controlled = {'packages': [{'source': 'npm:@scope/tool@2', 'extensions': []}, './packages/pi-routing-compat']}
        result = settings.merge(copy.deepcopy(original), controlled, self.agent)
        self.assertEqual(len(result['packages']), 3)
        self.assertEqual(result['packages'][0]['source'], 'npm:@scope/tool@2')
        self.assertEqual(original['packages'][0], 'npm:@scope/tool@1')
        self.assertEqual(settings.package_key('git:git@github.com:owner/repo@v1', self.agent), 'git:git@github.com:owner/repo')
        self.assertEqual(settings.package_key('git:git@github.com:owner/repo', self.agent), 'git:git@github.com:owner/repo')

    def test_idempotence_and_backups(self):
        (self.agent / 'settings.json').write_text('{}')
        self.assertTrue(self.apply())
        self.assertTrue(list(self.agent.glob('settings.json.bak-*')))
        snapshot = {p: p.stat().st_mtime_ns for p in (self.agent / 'settings.json', self.config / 'ponytail/config.json')}
        self.assertEqual(self.apply(), [])
        self.assertEqual(snapshot, {p: p.stat().st_mtime_ns for p in snapshot})

    def test_missing_compat_does_not_activate_filters(self):
        (self.agent / 'packages/pi-routing-compat/entry.ts').unlink()
        with self.assertRaisesRegex(RuntimeError, 'Build routing-compat'):
            self.apply()
        self.assertFalse((self.agent / 'settings.json').exists())

    def test_invalid_existing_layer_prevents_partial_settings_write(self):
        (self.agent / 'auto-model.json').write_text('not JSON')
        with self.assertRaises(json.JSONDecodeError):
            self.apply()
        self.assertFalse((self.agent / 'settings.json').exists())

    def test_nondefault_config_directory(self):
        alternative = self.home / 'xdg config'
        settings.apply(self.agent, PI, alternative)
        self.assertTrue((alternative / 'ponytail/config.json').is_file())
        self.assertFalse(self.config.exists())


class VersionTests(unittest.TestCase):
    def run_version(self, version, fail=False):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'version').write_text(version)
            cli = root / 'fake pi'
            cli.write_text('#!' + sys.executable + '\n' + '''import sys
from pathlib import Path
root = Path(__file__).parent
if sys.argv[1] == '--version':
    print((root / 'version').read_text())
else:
    (root / 'updated').write_text('yes')
    if (root / 'fail').exists(): sys.exit(1)
    (root / 'version').write_text('1.4.0')
''')
            cli.chmod(0o755)
            if fail:
                (root / 'fail').touch()
            result = subprocess.run(['bash', str(PI / 'ensure-version.sh'), str(cli)], capture_output=True, text=True, timeout=10)
            return result.returncode, (root / 'updated').exists()

    def test_current_pi_is_not_updated(self):
        self.assertEqual(self.run_version('1.4.0'), (0, False))

    def test_old_pi_is_updated_before_package_activation(self):
        self.assertEqual(self.run_version('1.3.0'), (0, True))

    def test_failed_pi_update_stops_bootstrap(self):
        code, called = self.run_version('1.3.0', fail=True)
        self.assertNotEqual(code, 0)
        self.assertTrue(called)


@unittest.skipUnless(os.environ.get('PI_TEST_NPM'), 'Set PI_TEST_NPM to the offline pinned npm/node_modules fixture')
class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.agent = self.root / 'home with spaces/.pi/agent'
        (self.agent / 'npm').mkdir(parents=True)
        (self.agent / 'npm/node_modules').symlink_to(Path(os.environ['PI_TEST_NPM']))

    def test_patches_are_reproducible_relative_and_idempotent(self):
        self.assertTrue(builder.install(self.agent))
        destination = self.agent / 'packages/pi-routing-compat'
        manifest = json.loads((destination / 'patch-manifest.json').read_text())
        for relative, expected in manifest.items():
            self.assertEqual(builder.digest(destination / relative), expected['patched_sha256'])
        links = [p for p in destination.rglob('*') if p.is_symlink()]
        self.assertTrue(links)
        self.assertTrue(all(not Path(os.readlink(p)).is_absolute() for p in links))
        self.assertFalse(builder.install(self.agent))
        self.assertFalse((self.agent / 'backups').exists())
        (destination / 'entry.ts').write_text('// previous local change\n')
        self.assertTrue(builder.install(self.agent))
        self.assertEqual(len(list((self.agent / 'backups').glob('pi-routing-compat-*'))), 1)
        backup = next((self.agent / 'backups').glob('pi-routing-compat-*'))
        self.assertEqual((backup / 'entry.ts').read_text(), '// previous local change\n')

    def test_wrong_upstream_pin_is_rejected(self):
        fake = self.root / 'missing agent'
        (fake / 'npm/node_modules/pi-auto-model').mkdir(parents=True)
        (fake / 'npm/node_modules/pi-auto-model/package.json').write_text('{"version":"0.0.0"}')
        with self.assertRaisesRegex(RuntimeError, 'Install npm:pi-auto-model@0.9.1'):
            builder.install(fake)
        self.assertFalse((fake / 'packages').exists())

    def test_old_pi_is_rejected_before_replacing_package(self):
        host = self.root / 'host'
        package = host / '@earendil-works/pi-coding-agent'
        package.mkdir(parents=True)
        (package / 'package.json').write_text('{"version":"1.3.0"}')
        with self.assertRaisesRegex(RuntimeError, 'Pi 1.4.0'):
            builder.install(self.agent, host_modules=host)
        self.assertFalse((self.agent / 'packages').exists())


if __name__ == '__main__':
    unittest.main()
