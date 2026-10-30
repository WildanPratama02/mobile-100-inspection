---
name: orca-pipeline
description: Run one phase of docs/08-implementation-plan.md through Orca orchestration. Claude plans each task and asks the user to approve it, a Codex worker builds it, Codex and Claude workers review it, and Claude integrates (checks, one commit per task, PR at the end). Use when the user types /orca-pipeline <phase or task>, or asks to run a phase with Orca, Codex builder, reviewers or the agent pipeline.
---

# Orca pipeline: Planner → Codex Builder → Codex / Claude Reviewer → Claude Integrator

You are the **coordinator**. You play the Planner and the Integrator yourself, and start the Builder and Reviewer workers through Orca. The human-facing description is `docs/09-agent-workflow.md`. Orca's own rules come from `orca skills get orchestration`. Load it once at the start and keep its safety floor: positive proof before stop/retry/release, process every message before you ack it, and decide each settled worker's next owner.

`ARGS` is a phase (`7`, `Phase 7`) or one task (`T7.2`). For a single task, the steps below run for that task only.

## Hard limits

- **`CLAUDE.md` rules apply to every role.** This includes the hard rules, "doc wins", "two docs disagree → stop and ask", and open questions OQ-xx → stop and ask.
- **No code before the user approves the task's plan.** The approval goes through the task's decision gate.
- **Builders and reviewers never commit, push or merge.** You commit, one commit per task. You push and open the PR at the end of the phase. You merge only when the user says so.
- **Reviewers are read-only.** Their findings go back to the Builder (Orca review ownership); you don't fix code yourself. After 2 fix rounds with blocking findings left, ask the user through a gate.
- **Never read, copy or print `.env` or `secrets/`.** The worktree gets its test database from `pnpm worktree:setup`.
- **Use the executable `orca`** for every command. If a command fails, report the exact error and don't switch tools. Never use a non-Orca subagent for Builder or Reviewer work.

## 0. Preconditions (stop and tell the user if one fails)

1. `orca status --json`: `runtimeState` is `ready`.
2. `orca repo show --repo path:<repo root> --json`: `kind` is a Git repo, not `folder`. A folder project can't create worktrees; the user re-adds the project as a Git repository in Orca. `hookSettings.scripts.setup` is `pnpm worktree:setup`.
3. `git status` on `main` is clean apart from untracked worktrees. `AGENTS.md` and this skill are committed. The phase's specs (ADR, docs) are on `main`.
4. The phase in `docs/08-implementation-plan.md` exists and you have read its tasks, its ADR and the doc sections it names.

## 1. Worktree and Run

```text
orca worktree create --name <branch, e.g. phase-7-psi-report> --no-parent --setup run --json
orca orchestration run-create --objective "<Phase N: title (ADR-xxx)>" --json
```

Keep the worktree `id` (`<repoId>::<path>`) and the Run id. Wait for setup to finish (`orca terminal wait` on the setup terminal, with `--timeout-ms`). Read its output: "wrote …apps/api/.env" means the database tests can run. A "missing secrets/test-db.json" warning means they can't, so tell the user before T-tasks that need them.

Every artifact lives in the worktree, under `.agent-work/<task>/` (gitignored):
- `plan.md` (you)
- `build-<n>.md` (Builder, round n)
- `review-codex-<n>.md`, `review-claude-<n>.md` (Reviewers)
- `integrate.md` (you)

## 2. Plan every task, then gate it (Planner)

For each unchecked task of the phase, in plan order:

1. Write `.agent-work/<task>/plan.md` from `plan-template.md` in this folder: the files to touch, the tests to add, every acceptance check of the task copied verbatim, the doc sections to follow, and the commands to run.
   - If the docs leave a decision open, or two docs disagree, put it under "Questions". Don't decide it.
2. Create the task and its gate. `--deps` holds the previous task's id: tasks run one after another in the one worktree.

   ```text
   orca orchestration task-create --task-title "<T7.2 Shared rules>" --spec "<Builder spec from builder-spec.md>" --deps '["<previous task id>"]' --json
   orca orchestration gate-create --task <task_id> --question "Approve the plan in <worktree>/.agent-work/<task>/plan.md?" --options '["approve","revise","stop"]' --json
   ```

   - A docs-only task (e.g. T7.1) may share one approval with the phase plan when the user agreed to that.
3. Show the user the plan summaries, with the questions first. When the user answers, resolve each gate:

   ```text
   orca orchestration gate-resolve --id <gate_id> --resolution "approve" --json
   ```

   - **revise:** change `plan.md` and the task spec, then ask again.
   - **stop:** the task and every task depending on it stay unbuilt. Report it.

## 3. Build (Codex)

Start the next ready, approved task. The first task uses the phase worktree, and so does every later one.

```text
orca orchestration task-list --ready --brief --json
orca orchestration worker-start --task <task_id> --worktree id:<worktree id> --agent codex --json
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

- **Questions.** Answer a Builder's question with `orchestration reply` only when the docs or the approved plan answer it. Otherwise ask the user and relay the answer.
- **`worker_done`.** Check it against the expected Dispatch, then read `build-<n>.md`. `--outcome failed`, or a report showing a failing check, goes to the user with the evidence.
- **Release.** After an accepted settlement, `worker-release` the Builder unless a fix round follows right away. For an immediate fix round you may reuse its proven terminal (`worker-start --task <fix task> --terminal <handle> --worktree id:<worktree id>`).

## 4. Review (Codex and Claude in parallel)

For a code task, start both Reviewers before waiting. For a docs-only task, start the Claude Reviewer only. Use `reviewer-spec.md` for both specs.

```text
orca orchestration worker-start --spec "<Codex reviewer spec>" --task-title "<T7.2 review (Codex)>" --worktree id:<worktree id> --agent codex --json
orca orchestration worker-start --spec "<Claude reviewer spec>" --task-title "<T7.2 review (Claude)>" --worktree id:<worktree id> --agent claude --json
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

After both reports are in, sort each finding:
- **blocking:** a hard rule, a spec or acceptance check, a failing check, or a correctness bug.
- **follow-up.**
- **rejected:** say why.

Then:
- **No blocking finding:** go to step 5.
- **Blocking findings:** create a fix task. Its spec holds the blocking findings verbatim, the report paths and the same constraints. Then go back to step 3, round n+1.
- **Blocking findings after round 2:** create a gate asking the user to choose between fix again, accept as is, or stop.

Release every settled Reviewer.

## 5. Integrate (Claude)

In the worktree:
1. Read the whole diff yourself.
2. Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test`. For a UI task also run the Playwright test for that flow, with the worktree ports from `docs/09-agent-workflow.md`. Record the commands and their results in `integrate.md`. A failure is not covered up: send it back to the Builder (step 3) or report it.
3. Tick the task's checkboxes in `docs/08-implementation-plan.md`. If scripts changed, update `CLAUDE.md` → Commands.
4. Commit the task as one commit, message `T7.2: <what it does>`, ending with the attribution lines from the system reminder. Never use `--no-verify`.

Then go to the next task (step 3).

## 6. End of phase

1. Run `worker-list --run <run_id> --terminal-state reclaimable --json`, and keep releasing workers until it returns none.
2. Set the phase heading in `docs/08` to `· Done <date>` in a last commit.
3. Run `git push -u origin <branch>`, then `gh pr create`. The PR body lists each task with its commit, the checks you ran, the reviewer findings left as follow-up, and the attribution line.
4. Report to the user, per task: the outcome, the evidence (commit, checks, review rounds), and any blocker. Give the PR link. **Do not merge.**

## Recovery

- **`worker-start` exits non-zero:** don't relaunch. Read `failedStage` and `residualResources`, then load `orca skills get orchestration --reference references/recovery-and-cleanup.md`.
- **After a coordinator restart:** run `orca orchestration run-use --id <run_id>`. The task list, the gates and `.agent-work/` hold the state.
- **Three empty waits in a row:** run `worker-list --include-remote --json` and act on `projection.nextAction`. Absence is never proof that a worker stopped.
