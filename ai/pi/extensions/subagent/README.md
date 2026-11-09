# Pi PR review

`ai/bootstrap.sh` installs `/code-review` on macOS and WSL. It links the
prompt, both reviewer agents and this extension into `~/.pi/agent`.
Existing files or directories are moved to `~/.pi/agent/backups/` before
replacement. Backups stay outside Pi's resource-discovery directories.

After pulling the dotfiles on the Mac, run:

```bash
~/work/repos/.dotfiles/ai/bootstrap.sh
```

Then run `/reload` in an existing Pi session:

```text
/code-review 123
/code-review https://github.com/OWNER/REPO/pull/123 --comment
```

The command starts four independent reviewers, with at most two running
at once, then validates each candidate finding. `code-review-rules` uses
`claude-bridge/claude-sonnet-5-5`; `code-review-bugs` uses
`claude-bridge/claude-opus-5-5`. Both receive only `read`, `grep`, `find` and
`ls`, with Ponytail off and MCP access excluded. Provider authentication
stays local to each machine.

Without `--comment`, results stay in the terminal. Publication requires
that flag and a complete review of the current head SHA. The prompt does
not authorize edits, checkout, test execution, approval or merge.

This is not a sandbox: children retain the user's filesystem permissions
and inherit their environment. The extension does not register nested
delegation in child processes.

The extension is a local copy of Pi 1.4.0's MIT-licensed
[subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent),
with bounded concurrency, tool exclusions, inherited dispatch settings and
support for symlinked agent files. `index.ts` and `agents.ts` travel together;
they do not depend on an old installer release remaining on disk.

## Offline checks

From the dotfiles root:

```bash
python3 -m unittest discover -s tests -p 'test_pi_resources.py' -v
node --test tests/pi-code-review.test.mjs
```

The Node test uses the installed Pi SDK and simulated child processes.
It checks discovery, reviewer models and tools, concurrency and failure
reporting without model calls or GitHub access. It does not test review
quality or authenticate providers. Set `PI_SDK_DIR` to a Pi package
directory when using a nonstandard installation.
