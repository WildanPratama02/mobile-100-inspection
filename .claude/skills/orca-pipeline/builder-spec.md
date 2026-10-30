# Builder spec (Codex)

Fill the `<…>` fields and pass the text as the task's `--spec`. Keep it self-contained: the Builder sees only this spec, `AGENTS.md` / `CLAUDE.md` and the repository.

```text
ROLE: Builder for <task id> "<title>" of the M100 repository. Follow AGENTS.md (it sends you to CLAUDE.md; every rule there applies).

TARGET: worktree <path>, branch <branch>. Approved plan: .agent-work/<task>/plan.md (read it first; it is the scope).
<For a fix round: also .agent-work/<task>/review-codex-<n>.md and review-claude-<n>.md; fix exactly these blocking findings:>
<findings verbatim>

CHANGE: <one paragraph: the result to produce, in the words of the plan>.

CONSTRAINTS:
- Do only this task. Files outside the plan's file list need a question to the coordinator first (use the ask command of your preamble).
- Specs win: docs/08 task, <ADR>, <doc sections>. If a doc is unclear or two docs disagree, ask; never guess.
- Never read, print or copy .env or secrets/. Never touch a production database or photo folder.
- Do not commit, push, merge or rebase. Leave the changes in the working tree.
- Windows: paths through node:path, no bash scripts in deploy/ or scripts/.

OWNERSHIP: you may edit the files in the plan's file list and their tests. .agent-work/<task>/build-<n>.md is yours.

ACCEPTANCE: every acceptance check in plan.md passes, and these commands pass in the worktree: <commands from plan.md>.
Write .agent-work/<task>/build-<n>.md: files changed, tests added, each command with its result (pass/fail and the decisive line), anything left undone and why.
Then send worker_done once, with --outcome succeeded only when every command passed, else --outcome failed, and --report-path .agent-work/<task>/build-<n>.md.
```
