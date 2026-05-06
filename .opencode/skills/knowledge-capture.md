# Knowledge Capture Skill

Use this skill whenever you learn something reusable while working in this dotfiles setup.

## Goal

Do not let useful knowledge stay only in the conversation. Promote durable knowledge into the repo.

## When to use

- You discover a non-obvious behavior in one of the shell scripts or tools.
- You find a recurring setup issue or workaround.
- You learn a required step for a subsystem (WSL networking, tmux, zsh plugin, etc.).
- You identify a reusable way an AI agent should approach a recurring task in this repo.

## Where to record it

1. **`README.md`** — if it's user-facing: a new command, alias, or usage tip
2. **`.opencode/skills/*.md`** or **`.claude/skills/*.md`** — if it's a reusable agent workflow or decision rule
3. **The script itself** (inline comment) — only when the *why* is non-obvious from the code

## Decision rule

- User-facing tip or command → `README.md`
- Reusable agent workflow → add or update a skill file
- Non-obvious code behavior → inline comment in the script

## Quality bar

- Capture only stable, reusable knowledge — not one-off task details
- Keep it concise and specific
- Prefer updating existing docs over creating duplicate files

## Completion check

Before finishing a task, ask:
- Did I learn anything that will matter again in this setup?
- If yes — did I document it?
