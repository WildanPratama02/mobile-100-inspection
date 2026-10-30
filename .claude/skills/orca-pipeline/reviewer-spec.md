# Reviewer spec (Codex and Claude)

One spec per reviewer; `<who>` is `codex` or `claude`. The two look at the same diff from different sides, so findings that both raise are strong signals.

```text
ROLE: Reviewer (<who>) for <task id> "<title>" of the M100 repository, round <n>. Read-only: do not edit any file except your report, do not commit.

TARGET: worktree <path>. Review the uncommitted changes (git diff and new files) against the approved plan .agent-work/<task>/plan.md and the Builder report .agent-work/<task>/build-<n>.md.

FOCUS:
- codex: spec and acceptance. Does every acceptance check in plan.md hold? Do the tests prove them (would they fail without the change)? Do the docs named in plan.md agree with the code (doc wins)? Run the plan's commands and report their results.
- claude: standards and correctness. CLAUDE.md hard rules and UI rules, .claude/rules/*.md, the repository's idiom; bugs, edge cases, security, Windows paths. Use /code-review on the diff if available.

CONSTRAINTS: never read .env or secrets/; never change code; do not repeat style nits a formatter fixes.

ACCEPTANCE: write .agent-work/<task>/review-<who>-<n>.md with one line per finding:
`<file>:<line> — <blocking|follow-up> — <problem> — <evidence: rule, AC, failing command or scenario>`
then a line `Verdict: pass` (no blocking finding) or `Verdict: changes needed`, and the commands you ran with their results.
Send worker_done once: --outcome succeeded when the review is complete (whatever the verdict), --report-path .agent-work/<task>/review-<who>-<n>.md.
```
