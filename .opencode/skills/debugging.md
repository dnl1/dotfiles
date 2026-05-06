# Debugging Skill

Use this skill when diagnosing unexpected behavior in shell scripts, zsh config, or setup tooling.

## Goal

Find the root cause with the smallest reliable investigation, then apply the smallest correct fix.

## Workflow

1. **Reproduce** — run the narrowest command or action that shows the issue.
2. **Check local scope first** — inspect the specific script, alias, or config section before widening.
3. **Follow the real execution path** — trace sourcing order, PATH resolution, variable expansion.
4. **Verify assumptions** — don't guess shell behavior; test it with `echo`, `type`, or `set -x`.
5. **Minimal fix** — don't refactor broadly unless the root cause requires it.
6. **Verify** — run the affected command or re-source the config to confirm the fix.

## Shell-specific reminders

- Use `set -x` at the top of a script to trace execution line by line.
- Use `type <cmd>` to confirm whether a command resolves to alias, function, or binary.
- Use `echo $PATH` and `which <cmd>` to debug PATH-related failures.
- Source order matters: `.zshrc` → oh-my-zsh → plugins → user config at the bottom.

## Completion check

- Can the bug be explained in one concrete root-cause statement?
- Did the verification step exercise the changed path?
- Did I capture any reusable lesson? (→ knowledge-capture skill)
