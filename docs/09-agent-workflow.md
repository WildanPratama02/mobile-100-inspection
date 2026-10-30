# Mobile 100% Inspection — Agent Workflow (Orca)

| | |
|---|---|
| Status | Draft v0.1 (30 Oct 2026) |
| Applies to | Building a phase of `docs/08-implementation-plan.md` with several coding agents |
| Run by | `/orca-pipeline <phase or task>` in Claude Code (skill `.claude/skills/orca-pipeline/`) |

A phase is built by four roles. Orca orchestration links them: a Run per phase, a Task per step, decision gates for the user's approvals. The rules of `CLAUDE.md` apply to every role. `AGENTS.md` points Codex to them.

```
 user ──approve plan (gate)──┐                                   user ──merge──▶ main
                             ▼                                                   ▲
 Claude Planner ──plan.md──▶ Codex Builder ──build.md──▶ Codex Reviewer ─┐       │
   (coordinator)                   ▲                     Claude Reviewer ┤       │
                                   └──── blocking findings (≤ 2 rounds) ◀┘       │
                                                          no blocking ──▶ Claude Integrator ──commit per task, PR
```

## Roles

| Role | Agent | Does | Never |
|---|---|---|---|
| Planner | Claude (the coordinator session) | Reads the phase, its ADR and docs. Writes `plan.md` per task (files, tests, acceptance checks, commands, questions). Puts each plan to the user through a decision gate. | Decides an open question or a doc conflict |
| Builder | Codex worker | Implements one approved plan in the phase worktree. Runs the plan's commands. Writes `build-<n>.md`. | Commits, pushes, works outside the plan |
| Reviewer | Codex worker and Claude worker, in parallel (docs-only task: Claude only) | Codex: the acceptance checks, tests and doc agreement. Claude: the hard rules, standards and bugs. Each writes `review-<who>-<n>.md` with blocking / follow-up findings and a verdict. | Edits code |
| Integrator | Claude (the coordinator session) | Sorts the findings. Sends blocking ones back to the Builder (at most 2 rounds, then the user decides). Reads the diff and runs typecheck, lint, format check, tests (and Playwright for UI). Ticks doc 08 and commits one commit per task (`T7.2: …`). Opens the PR at the end of the phase. | Merges without the user's word, or covers up a failing check |

One phase is one branch in its own Orca worktree, with tasks built one after another, one commit per task and one PR (as Phase 6 and Phase 7 were planned). The coordinator runs in the main checkout.

## Artifacts

Each task's artifacts are in the phase worktree under `.agent-work/<task>/`. They are gitignored and kept until the worktree is removed.

| File | Written by |
|---|---|
| `plan.md` (template `.claude/skills/orca-pipeline/plan-template.md`) | Planner |
| `build-<n>.md` | Builder, round n |
| `review-codex-<n>.md`, `review-claude-<n>.md` | Reviewers, round n |
| `integrate.md` (commands run, results, commit) | Integrator |

Orca keeps the Run, its tasks, gates and messages (`orca orchestration task-list`, `gate-list`, `inbox`).

## One-time setup

1. **Orca knows the project as a Git repository.** `orca repo show --repo name:mobile-100-inspection --json` must not say `"kind": "folder"`. If it does, remove the project in Orca and add `D:\Project\mobile-100-inspection` again as a repository (`orca repo add --path <path>`). A folder project cannot create worktrees.
2. **Setup script.** In Orca → the project's settings → setup script: `pnpm worktree:setup`. That is `scripts/worktree-setup.mjs`: it runs `pnpm install` and gives the worktree an `apps/api/.env` naming only the test database server. The real `.env` is never read or copied, and the main checkout is refused.
3. **Test database.** Database tests and e2e need a local PostgreSQL 16 superuser that may create and drop `m100_test_*` databases. Use a cluster of its own, never the server holding `m100_dev` or production data. For example, in PowerShell with the PostgreSQL 16 binaries in `$bin`:

   ```powershell
   & "$bin\initdb.exe" -D "$env:LOCALAPPDATA\m100-testdb" -U postgres -A scram-sha-256 --pwfile <file with a new random password>
   & "$bin\pg_ctl.exe" -D "$env:LOCALAPPDATA\m100-testdb" -o "-p 55418 -c listen_addresses=localhost -c max_connections=300" -l "$env:LOCALAPPDATA\m100-testdb.log" start
   ```

   Then create `secrets/test-db.json` in the main checkout. It is gitignored, and agents never read it; only the setup script does.

   ```json
   { "testAdminDatabaseUrl": "postgres://postgres:<password>@localhost:55418/postgres", "pgBin": "<the $bin folder>" }
   ```

   The script refuses a URL that does not point at `localhost`. Without the file, setup still installs packages, but database and e2e tests do not run in the worktree.
4. **Agents.** `orca status` is `ready`, and `codex` and `claude` are enabled agents in Orca.

## Running a phase

1. Merge the phase's specs (ADR, doc 08 phase) to `main`.
2. In an Orca terminal or chat in the main checkout, start Claude Code and type `/orca-pipeline 7` (or `/orca-pipeline T7.2` for one task).
3. Claude creates the worktree (setup runs) and the Run, plans every task, and shows you the plans and their questions.
4. Answer each plan with **approve**, **revise** or **stop**. You can say it to Claude, which resolves the gate, or resolve the gate in Orca.
5. Builders and reviewers run without you, unless a worker asks something the docs don't answer, or blocking findings remain after 2 fix rounds.
6. At the end Claude reports per task (outcome, commit, checks, review rounds) and gives the PR link. Merging is your call.

## Ports in a worktree

The main checkout's dev servers keep their ports, so worktree tests use others:
- web: `E2E_PORT=5174 E2E_PREVIEW_PORT=4174 E2E_API_PORT=3101 pnpm --filter web e2e`
- admin: `E2E_API_PORT=3103 E2E_ADMIN_PORT=5177 pnpm --filter admin e2e`

## When something goes wrong

- **A worker failed to start:** Claude reads the receipt and follows Orca's recovery guide. It never relaunches blindly.
- **Claude restarted:** `/orca-pipeline` resumes with `orca orchestration run-use --id <run id>`. The state is in Orca and `.agent-work/`.
- **A check fails at integration:** the task goes back to the Builder, or to you with the failing output. Nothing is committed red.
