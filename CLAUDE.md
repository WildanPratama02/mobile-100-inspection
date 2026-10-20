# Mobile 100% Inspection (M100)

Tap-only tablet PWA for PSI lv.1 / lv.2 inspectors at PT Parkland World Indonesia to record footwear defects per PO. Results are stored through a NestJS API in the app's own PostgreSQL 16 database, photos in a photo store (a folder for release 1); administrators keep master data and read submissions in a small admin web app (ADR-018). The old Google Sheet "100%INLINE IMPACTIVA" and its AppSheet app are no longer read or written.

## Where the truth lives

Read the doc a task needs before writing code. Do not invent behaviour that a doc does not state.

| Need | Read |
|---|---|
| Which task to do next, and its acceptance tests | `docs/08-implementation-plan.md` |
| What the app must do (FR, BR, NFR, open questions OQ) | `docs/01-prd.md` |
| Tables, constraints, master-data import, the submission write order, photo keys, reporting views, readiness checks, backup | `docs/02-data-design.md` (v2.0) |
| Endpoints (tablet and admin), request/response shapes, validation, error codes, outbox behaviour | `docs/04-api-contract.md` + `docs/04-openapi.yaml` (v2.0) |
| How it is built and run: PWA storage, outbox, API modules, Submit PO procedure, PhotoStore, admin app, security, deployment, backup | `docs/03-tdd.md` |
| Screens, states, interactions, copy, layouts (tablet S0–S9, admin A0–A7 in §20) | `docs/05-ui-ux-spec.md` |
| Why a choice was made (ADR-001 … ADR-018) | `docs/07-decision-log.md` |
| Which docs exist and which are still Planned | `docs/00-document-map.md` |
| Screen layout and interaction flow | `reference/prototype/app.html` (open in a browser). Its **colours and styling are outdated**; take layout and behaviour from it, never its look. |
| Look, tokens, components | `design-system/README.md`, `design-system/tokens.json`, `design-system/components/*/README.md`, reference implementation in `design-system/components/bundle.js` + `bundle.css` |
| Area → sub-area → family → defect mapping | `reference/mapping/mapping.json` (generated from `Footwear_Defect_Mapping_Database_v2.xlsx`) |

Doc 02 (Data Design, v2.0) and doc 04 (API Contract, v2.0) are final; doc 03 (TDD) is a draft (v0.3) and is the spec for how things are built. ADR-018 (PostgreSQL + photo store) supersedes ADR-001, 002, 007, 011, 012 and 017; never build anything from those. Doc 05 (UI/UX spec, draft v0.2) defines every screen S0–S9 and the admin screens A0–A7; where it disagrees with the prototype, doc 05 wins. U1, U2 and U10 in doc 05 §18 are confirmed (20 Oct 2026). Phase 4 starts with the server pre-checks of doc 03 §7.3. The server is **Windows**, operated by the QIP Digital Team: no bash scripts in `deploy/` or `scripts/` (use Node/TypeScript or PowerShell) and always build paths with `node:path`. HTTPS is decided: `https://m100.qdms.web.id` (ADR-016). If a task depends on something not decided in the docs, stop and say so instead of guessing.

## Stack (ADR-004, ADR-005, ADR-018; React + Vite confirmed)

pnpm workspace monorepo:
- `apps/web`: React 18 + TypeScript + Vite, `vite-plugin-pwa` (Workbox), Zustand (state), Dexie (IndexedDB for sessions, photos, outbox).
- `apps/api`: NestJS + TypeScript on PostgreSQL 16 (`pg` pool; TypeORM for the admin CRUD entities; explicit SQL for the submission write). All database access behind repository interfaces; photos behind `PhotoStore` (`DiskPhotoStore` for release 1, `S3PhotoStore` optional).
- `apps/admin`: React + Vite admin web app served at `/admin/` (Phase 3b; not scaffolded yet).
- `db/migrations/`: explicit SQL migrations (T2.2; not created yet).
- `packages/shared`: types, the counting engine, mapping loader, number/date formatters. Used by the apps and the API.

Tests: Vitest (unit), Playwright (web end-to-end), Jest (NestJS default; repository tests against a real PostgreSQL test database). Node 22 LTS.

## Hard rules

1. **Never touch the production database or photo folder.** Development uses `m100_dev`, tests create their own database per run; connection strings come from `DATABASE_URL` / `MIGRATE_DATABASE_URL` in `.env`. Never hard-code a connection string or secret, never commit `.env` or anything in `secrets/`.
2. **Submissions are immutable (BR-07, ADR-018).** No UPDATE or DELETE on `submissions`, `submission_findings`, `submission_photos`; a trigger and the grants enforce it, and there is no void. Master data is deactivated, never deleted.
3. **One Submit PO = photos into the photo store first, then one database transaction** (`submissions` row with `INSERT … ON CONFLICT (id) DO NOTHING`, its findings and photo rows, SQL re-check of the sums), keyed by the tablet's UUID plus `payload_sha256`. The answer is synchronous (`201`, or `200` for a repeat; `409` for the same UUID with other bytes); no queue, no `202`. Every step is safe to repeat, so a retry never duplicates (doc 02 §6, doc 03 §5.4, ADR-003, ADR-018, BR-06).
4. **Taps never hit the network.** Every tap is saved to IndexedDB before the UI confirms it (NFR-03, NFR-05).
5. **Counting rules (BR-01, ADR-008)** live in one pure function in `packages/shared` with unit tests that reproduce the ADR-008 table exactly:
   - REWORK / B-GRADE / NO DEFECT tap: Qty Inspection +1; NO DEFECT also Qty A-Grade +1.
   - Defect during REWORK: Qty Defect +1. Defect during B-GRADE: Qty Defect +1 and Qty B-Grade +1 (per finding).
   - Defect Rate = Qty Defect ÷ Qty Inspection; Pass Rate (RFT) = Qty A-Grade ÷ Qty Inspection; show "—" when Qty Inspection is 0.
6. **Photos (FR-10, BR-04, doc 02 §4.3, §7):** PSI lv.2 takes exactly one photo per Top 5 defect (more only for a defect photographed while in the Top 5 that later left it, AC-10.4); PSI lv.1 takes no photos at all. One `submission_photos` row per defect, key `submissions/<yyyy>/<MM>/<uuid>/<defectId>.jpg`. JPEG ≤ 1 MB, never re-encoded on the server.
7. **Defect identity (ADR-009):** use `DEFECT_ID` D001–D098. D049 and D071 share a name; never key anything by defect name alone.
8. **Open questions (PRD §10; open now: OQ-05, OQ-06, OQ-09, OQ-10):** if a task touches one, stop and ask. Never pick an answer silently.

## UI rules

- Screen text in Bahasa Indonesia. These labels stay English and uppercase: ADD DEFECT, REWORK, B-GRADE, NO DEFECT, END INSPECTION, BACK, HOME, UNDO, SUBMIT PO, LOGIN, EXPORT PDF, EXPORT EXCEL, TOP 5 DEFECT, QTY INSPECTION, DEFECT RATE, PASS RATE (RFT).
- Defect names exactly as in the mapping (case and brackets kept).
- Numbers `id-ID` (2.400; 18,8%), times WIB (Asia/Jakarta).
- No device keyboard on the tablet app except the PO search box (the admin app at `/admin/` may use the keyboard, doc 05 U17); numbers (the PO partial quantity, ADR-013) use the app's own number pad. Every tappable element ≥ 44 × 44 px (`--tap-min`).
- Colours, radius, spacing, type only through the CSS variables in `design-system/tokens.css`. No hex values in components. Accent is `#1D4ED8` (`--accent`); black (`--ink`) is text only; grey (`--disabled`) means disabled.
- Port design-system components to React components in `apps/web/src/ui/` with the same names and props as `design-system/components/index.d.ts`. `ShoeMap` must keep the anchor coordinates and image box from `bundle.js`; only the pill docks change on a short map (doc 05 U13, `SHOE_AREAS_COMPACT`).
- Fonts must work offline: self-host Barlow Condensed, Barlow Semi Condensed and IBM Plex Mono (e.g. `@fontsource/*`), not the Google Fonts `@import`.

## How to work

- One task from `docs/08-implementation-plan.md` per session. Start in plan mode, list the files you will touch and the tests you will add, wait for approval.
- Before saying a task is done: typecheck, lint, unit tests and (for UI tasks) the Playwright test for that flow must pass. Report the commands you ran.
- Commit per task: `T1.3: counting engine with ADR-008 tests`.
- If a doc and the code disagree, the doc wins; if two docs disagree, stop and ask.
- Update this file's Commands section when scripts change.

## Commands

<!-- Fill in after T0.1 scaffolds the repo. -->
Node 22 LTS ≥ 22.13 and pnpm 10 (`packageManager` in `package.json`; `engine-strict` is on). Packages: `web`, `api`, `@m100/shared`.

- `pnpm install`
- `pnpm e2e:install` (once per machine: Playwright's Chromium)
- `pnpm dev` (web on `http://localhost:5173`; dev-only UI kit catalogue at `/ui`), `pnpm --filter api start:dev` (api on `127.0.0.1:3000`, builds `@m100/shared` first)
- `pnpm test` (Vitest in `web` and `@m100/shared`, Jest in `api`), `pnpm lint`, `pnpm typecheck`, `pnpm e2e`
- `pnpm e2e` also builds the web app and serves it with `vite preview` on `http://localhost:4173` for the `pwa` project (service worker, install, offline); the default project `tablet-landscape` uses the dev server. `pnpm --filter web e2e --project pwa` runs only the PWA tests.
- `E2E_PORT=5174 E2E_PREVIEW_PORT=4174 pnpm e2e` from a git worktree when another checkout's dev server holds 5173 or its preview holds 4173 (Playwright would otherwise reuse that dev server and test the other checkout's code)
- `pnpm format` / `pnpm format:check` (Prettier)
- `pnpm build` (shared → `packages/shared/dist`, web → `apps/web/dist`, api → `apps/api/dist`)
- One package only: `pnpm --filter <web|api|@m100/shared> <script>`
