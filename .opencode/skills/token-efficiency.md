# Token Efficiency Skill

## When to use

Apply this skill whenever running terminal commands or exploring files during a task.

## Core principles

1. **Prefer `rtk` for terminal commands** — filters noisy output before it reaches AI context (60-90% savings)
2. **Use dedicated tools for file operations** — Read, Grep, Glob instead of bash cat/find/grep
3. **Batch searches** — group multiple lookups in one tool call when possible

## RTK command reference

```bash
# Shell and git operations (automatic filtering)
rtk git status
rtk git diff --staged
rtk git log
rtk bash some-script.sh

# Meta commands (always use directly, never wrap with rtk)
rtk gain              # Show token savings analytics
rtk gain --history    # Show command usage history with savings
rtk discover          # Analyze history for missed opportunities
rtk proxy <cmd>       # Raw output — for debugging only
```

## Tool selection guide

| Task | Use this | Why |
|------|----------|-----|
| Git / shell command output | `rtk <cmd>` | Filters noise, 60-90% savings |
| Read a specific file | `Read` tool | Direct, no overhead |
| Search text in files | `Grep` tool | Fast and precise |
| Find files by pattern | `Glob` tool | Optimized for discovery |

## Anti-patterns to avoid

- ❌ Running raw `git status`, `git diff` without `rtk`
- ❌ Using bash `cat`, `find`, `grep` for file operations — use dedicated tools
- ❌ Keeping `rtk proxy` output in context — use only for debugging, then discard

## Verification

After completing a task, run:
```bash
rtk gain           # confirm savings achieved
rtk discover       # identify missed opportunities for next time
```
