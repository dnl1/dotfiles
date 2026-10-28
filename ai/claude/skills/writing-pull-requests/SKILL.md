---
name: writing-pull-requests
description: Write, open or update a pull request or merge request, its title or description, following the repository template. Use for 'open the PR', 'write the PR description', 'update the merge request summary' and pull_request_template.md. Not for reviewing code in an existing PR without changing its description, or for commit messages alone. Use humanizer before publishing the prose.
---

# Writing Pull Requests

## Overview

A PR description is the reviewer's map now and the project's record later: people find a change by searching
its title and read the body to learn why it exists. Write it for a reader who has not seen the ticket, the
chat, or the branch.

## The description is these parts, in this order

| # | Slot | What it holds |
|---|---|---|
| 1 | **Title** | One imperative sentence saying what the change does, readable alone in `git log`. Take the prefix convention from the repo's recent merged titles (`git log --oneline -15` on the base branch). |
| 2 | **Why** | The problem in 1–3 sentences, understandable without opening any link. Then the ticket key. |
| 3 | **What changed** | The approach and why this one, grouped by concern (not a file list). Known limitations and trade-offs. |
| 4 | **Risk & rollout** | Migrations, behavior users will notice, flags, data fixes. Leave it out when there are none. |
| 5 | **Review focus** — REQUIRED | The feedback you want: which part needs a careful second pair of eyes, or "a quick sanity check is enough". When the diff spans several layers or about 5+ files, the order to read it in. |
| 6 | **Testing** | What was run, which cases, where, and what is not covered. |
| 7 | **Screenshots** — REQUIRED when the diff changes what a user sees (components, templates, styles, copy) | Before/after images, or a `TODO: screenshot` line plus a question to the user. |
| 8 | **Follow-ups** | Out-of-scope problems noticed and deliberately left alone. |

**When the diff is one concern in a handful of lines:** write slots 2–4 as two short paragraphs with no
heading (the problem, then the fix), and slots 5–8 as bold-labelled lines (`**Review focus:** …`), each one or
two sentences.

**When the repo has a PR template** (`.github/pull_request_template.md`, `docs/`, or a `PULL_REQUEST_TEMPLATE/` dir):
keep every section in its order and put each slot in the section that matches it. Add `### Review focus` at the
end of the first section when no section fits. Replace the template's instruction comments with content.

## Facts you could not observe

Write only what the diff, the commits, the ticket, CI results or the conversation show. For everything else:

- Ticket key but no URL in front of you → write the key as plain text.
- No evidence the tests or a manual check were run → describe what the tests cover and write "not run by me",
  or ask.
- Before posting, end your reply to the user with the facts you could not verify (manual QA, screenshots,
  motivation the commits do not state) as questions, and keep a `TODO:` in the body for each one still open.

## Before posting: cut, then humanize

- Most readers stop after the first screen. Put what the PR does and why in at most ~10 plain lines at the top;
  anything only a reviewer needs (measurements, file-by-file notes, edge cases) goes in a collapsed
  `<details><summary>Full details</summary>` block at the end.
- Load the `humanizer` skill and apply it to the prose. Keep code, paths, ids, the slot order and the bold slot
  labels this skill asks for.

## After review changes the PR

Re-read the description before merge and update it, so it still says what the PR does.

Sources and how this skill was tested: `sources.md` in this directory.
