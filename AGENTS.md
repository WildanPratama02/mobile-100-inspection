# Mobile 100% Inspection (M100) — instructions for Codex and other agents

**Read `CLAUDE.md` in this folder first and follow all of it.** It is the single source of the project's rules: where the truth lives, the stack, the hard rules, the UI rules, how to work and the commands. Everything in it applies to you as well, even where it says "Claude". Also read `.claude/rules/*.md` for the area you touch (`api-postgres.md`, `web-ui.md`). This file only adds what differs for agents started by the Orca pipeline (`docs/09-agent-workflow.md`).

## When Orca started you as a worker

Your prompt then begins with an Orca preamble (Task and Dispatch ids) and a role: **Builder** or **Reviewer**. The preamble and the task spec are authoritative.

- Do only the task in the spec. Its approved plan is `.agent-work/<task>/plan.md`. A question the plan and the docs don't answer goes to the coordinator through the preamble's `ask` command. Never guess, and never open an interactive prompt.
- **Builder:** change the files of the plan and their tests. Run the plan's commands. Write `.agent-work/<task>/build-<n>.md`. **Do not commit, push, merge or rebase**, because the coordinator (Claude, the Integrator) commits each task.
- **Reviewer:** read-only. Write only `.agent-work/<task>/review-<you>-<n>.md` in the format the spec gives.
- Send `worker_done` exactly once, with `--outcome succeeded` or `--outcome failed` and `--report-path`. Then stop and wait.
- These replace `CLAUDE.md` → "How to work" for you: plan mode, the approval and the commits are the coordinator's. Its checks still bind you: typecheck, lint, the unit tests and, for UI, the Playwright test of the flow must pass before you report success.

## Never

- Read, print or copy `.env`, `.env.*` or anything in `secrets/`. A worktree's `apps/api/.env` is written by `pnpm worktree:setup` and names only the local test database server.
- Touch a production database or photo folder, or hard-code a connection string or secret.
- Change a submission row (BR-07), or decide an open question (OQ-xx) yourself.
