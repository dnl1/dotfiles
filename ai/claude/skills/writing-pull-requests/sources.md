# Sources behind writing-pull-requests

| Source | What the skill takes from it |
|---|---|
| Google eng-practices, [Writing good CL descriptions](https://google.github.io/eng-practices/review/developer/cl-descriptions.html) | Title: a standalone, imperative first line ("Fix bug" is inadequate). Body: the problem, why this approach, its shortcomings, background. Context must survive links that die. Re-read the description before submitting, because review changes the change. |
| GitHub Docs, [Helping others review your changes](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/getting-started/helping-others-review-your-changes) | Why it is needed, what changed, where to pay special attention. Say what kind of feedback you want; give a review order for multi-file changes. Self-review the diff first. |
| Pirouzkhah, Wurzel Gonçalves & Bacchelli, [The Value of Effective Pull Request Description](https://arxiv.org/html/2602.14611v1), MSR '26 | 80k PRs, 156 projects. Stating the feedback wanted had the strongest association with merge (OR ≈ 1.65–1.72) and with deeper discussion, yet appears in 16 % of PRs; code explanation ≈ 12–20 % more likely to merge; review order appears in 6 %, test explanation in 14 %. Observational, 2019 open-source data, most other effects negligible. |
| GitLab merge request workflow (contributor docs) | Explain why and how; before/after screenshots for UI changes; link the issue. |
| Stack Overflow Blog, [How to Make Good Code Reviews Better](https://stackoverflow.blog/2019/09/30/how-to-make-good-code-reviews-better/) and [This developer tool is 40 years old](https://stackoverflow.blog/2024/12/20/this-developer-tool-is-40-years-old-can-it-be-improved/) | Reviewers check the title and description for the "why". Smaller diffs are reviewed faster. |
| Graphite, Kodus, Willow guides (vendor blogs, weaker evidence) | Short overview first; risks, migrations and breaking changes stated; testing specific ("tested locally" says nothing); length proportionate. |

## How the skill was tested (2026-10-14)

Five scenarios, each written by a fresh agent without the skill and again with it: three synthetic (small fix,
feature with a repo template under time pressure, large refactor) and two real merged PRs given only branch,
commits and diff. Without the skill: review focus missing in 2/5, a UI change with no screenshot, one invented
Jira URL, and no unverifiable fact ever raised with the user. With it: all four present in 5/5. Those runs also
showed a one-line fix inflated to seven headings, so the compact form for small changes and the title-convention
check were added; five more runs of the small fix (three, then two after splitting the lead into problem and fix)
all came out in the same compact shape, and the template run kept every section.
