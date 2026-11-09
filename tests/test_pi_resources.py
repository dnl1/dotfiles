"""Offline checks for the Pi resource-linking block used on macOS and WSL."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP = (ROOT / 'ai/bootstrap.sh').read_text()
LINK_BLOCK = 'link_pi() {' + BOOTSTRAP.split('\nlink_pi() {', 1)[1].split('\n# pi would also install', 1)[0]


class PiResourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        self.ai = root / 'checkout with spaces/ai'
        self.agent = root / 'home with spaces/.pi/agent'
        self.sources = {
            'AGENTS.md': 'instructions\n',
            'lib/model-status.ts': '// helper\n',
            'extensions/local.ts': '// standalone extension\n',
            'extensions/subagent/index.ts': '// extension entry\n',
            'extensions/subagent/agents.ts': '// extension helper\n',
            'prompts/code-review.md': 'review prompt\n',
            'agents/code-review-rules.md': 'rules reviewer\n',
            'agents/code-review-bugs.md': 'bugs reviewer\n',
        }
        for name, content in self.sources.items():
            path = self.ai / 'pi' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.agent.mkdir(parents=True)

    def apply(self):
        return subprocess.run(
            ['bash', '-euo', 'pipefail', '-c',
             'skip() { :; }; ok() { :; }; warn() { :; };\n' + LINK_BLOCK],
            env={**os.environ, 'AI_DIR': str(self.ai), 'PI_DIR': str(self.agent)},
            capture_output=True, text=True, timeout=10, check=True,
        )

    def test_fresh_install_and_repeat_are_idempotent(self):
        self.apply()
        expected = ['AGENTS.md', 'lib', 'extensions/local.ts', 'extensions/subagent',
                    'prompts/code-review.md', 'agents/code-review-rules.md', 'agents/code-review-bugs.md']
        for name in expected:
            destination = self.agent / name
            self.assertTrue(destination.is_symlink(), name)
            self.assertEqual(destination.resolve(), (self.ai / 'pi' / name).resolve())
        self.assertFalse((self.agent / 'extensions/agents.ts').exists())
        self.apply()
        self.assertFalse((self.agent / 'backups').exists())

    def test_preserves_files_and_directories_outside_discovery_paths(self):
        prompt = self.agent / 'prompts/code-review.md'
        prompt.parent.mkdir(parents=True)
        prompt.write_text('local prompt\n')
        extension = self.agent / 'extensions/subagent'
        extension.mkdir(parents=True)
        (extension / 'index.ts').write_text('// local extension\n')
        unrelated = self.agent / 'extensions/personal.ts'
        unrelated.write_text('// keep\n')
        self.apply()
        backups = list((self.agent / 'backups').iterdir())
        self.assertEqual(len(backups), 2)
        self.assertTrue(any((p / 'code-review.md').is_file() and (p / 'code-review.md').read_text() == 'local prompt\n' for p in backups))
        self.assertTrue(any((p / 'subagent/index.ts').is_file() and (p / 'subagent/index.ts').read_text() == '// local extension\n' for p in backups))
        self.assertEqual(unrelated.read_text(), '// keep\n')
        self.apply()
        self.assertEqual(list((self.agent / 'backups').iterdir()), backups)
        self.assertEqual(sorted(p.name for p in (self.agent / 'prompts').iterdir()), ['code-review.md'])
        self.assertEqual(sorted(p.name for p in (self.agent / 'extensions').iterdir()), ['local.ts', 'personal.ts', 'subagent'])

    def test_replaces_broken_links_without_losing_them(self):
        old = self.agent / 'AGENTS.md'
        old.symlink_to('missing-instructions.md')
        self.apply()
        backup = next((self.agent / 'backups').glob('*/AGENTS.md'))
        self.assertTrue(backup.is_symlink())
        self.assertEqual(os.readlink(backup), 'missing-instructions.md')
        self.assertEqual(old.resolve(), self.ai / 'pi/AGENTS.md')

    def test_optional_resource_directories_can_be_absent(self):
        for name in ['prompts', 'agents', 'extensions/subagent']:
            shutil.rmtree(self.ai / 'pi' / name)
        self.apply()
        self.assertTrue((self.agent / 'extensions/local.ts').is_symlink())
        self.assertFalse((self.agent / 'prompts').exists())
        self.assertFalse((self.agent / 'agents').exists())


if __name__ == '__main__':
    unittest.main()
