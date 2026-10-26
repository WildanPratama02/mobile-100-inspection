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
- `apps/admin`: React + Vite admin web app served at `/admin/` (T3b.4): screens A0–A7 in `src/screens/`, the design-system components imported from `apps/web/src/ui` through the alias `@m100/ui` (never copied), the admin API client in `src/api/`.
- `db/migrations/`: explicit SQL migrations (T2.2), applied by `pnpm db:migrate`.
- `apps/api/src/repositories/`: one interface + `Pg…` implementation per table group (T2.3); `apps/api/src/photos/`: `PhotoStore`, `DiskPhotoStore`, and the shared contract suite in `src/testing/photo-store-contract.ts`.
- `packages/shared`: types, the counting engine, mapping loader, number/date formatters. Used by the apps and the API.
- `deploy/` (workspace package `deploy`, T4.1): `Caddyfile`, `security-headers.json` (also used by `vite preview` of web and admin), `windows/` PowerShell scripts (`precheck`, `install`, `upgrade`, `restore`, `m100` + `common.ps1`, ASCII only, Windows PowerShell 5.1) and WinSW templates, `build-release.mjs`; Vitest tests in `deploy/test/`.

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
Node 22 LTS ≥ 22.13 and pnpm 10 (`packageManager` in `package.json`; `engine-strict` is on). Packages: `web`, `admin`, `api`, `@m100/shared`, `deploy`.

- `pnpm install`
- `pnpm e2e:install` (once per machine: Playwright's Chromium)
- `pnpm dev` (web on `http://localhost:5173`; dev-only UI kit catalogue at `/ui`; proxies `/v1` to the API at `M100_API_URL`, default `http://127.0.0.1:3000`, so run the API too; a new browser profile first opens `http://localhost:5173/setup#k=<key>` with a key from `pnpm device:add`, else the app shows only "Tablet ini belum terdaftar"), `pnpm --filter api start:dev` (api on `127.0.0.1:3000` under `/v1`, e.g. `/v1/health`; builds `@m100/shared` first). The API reads `.env` from its working directory (`apps/api` for `start:dev`) and stops, naming the variables, unless `DATABASE_URL`, `PHOTO_STORE` (`disk` needs `PHOTO_DIR`; `s3` needs `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`), `JWT_KEY_FILE` and `TZ=Asia/Jakarta` are set; optional `PORT`, `LOG_LEVEL`, `MASTER_CHECK_SECONDS`, `SUBMIT_TIMEOUT_SECONDS` (doc 03 §7.4)
- `pnpm dev:admin` (admin app on `http://localhost:5175/admin/`, proxies `/v1` to `M100_API_URL` like `pnpm dev`, so run the API too; log in with an account from `pnpm admin:create`, e.g. `--dev-default`)
- `pnpm db:bootstrap` (once per PostgreSQL server, as superuser `ADMIN_DATABASE_URL`: roles `m100_migrate`, `m100_app`, `m100_report` with the passwords of `MIGRATE_DATABASE_URL`, `DATABASE_URL`, `REPORT_DB_PASSWORD`, and the database owned by `m100_migrate`), then `pnpm db:migrate` (applies `db/migrations/*.sql` with `MIGRATE_DATABASE_URL`; a second run applies nothing). Both build the API first and read `.env` from `apps/api`.
- `pnpm import-master --dir <folder> [--mapping <file>] [--dry-run]` (doc 02 §5.1): imports the old sheets (one `.xlsx` export or four CSVs in `<folder>`) and the mapping workbook (from `<folder>`, `--mapping`, or `reference/mapping/`) with `DATABASE_URL`; builds the API first, reads `.env` from `apps/api`, relative paths from where you run it. The real exports hold personal names: keep them in `secrets/master-data/` (gitignored), never in `reference/`.
- `JWT_KEY_FILE` must name a file of ≥ 32 random bytes or the API stops naming it; for development run `node -e "require('fs').writeFileSync('secrets/jwt.key', require('crypto').randomBytes(32))"` in the repo root and set `JWT_KEY_FILE` to that file's absolute path (a relative path is taken from `apps/api`). Tests make their own.
- `pnpm device:add --label "<label>" [--out <sheet.html>]` and `pnpm device:add --batch <tablets.csv> --out <sheet.html>` (doc 03 §7.5; CSV header `label`, one tablet per row): prints each key, setup link `https://<PUBLIC_HOST>/setup#k=<key>` and a terminal QR once; the batch writes one printable HTML sheet of QR codes (holds keys: keep it under `secrets/`, delete after setup). A label already registered or repeated refuses the whole run. `pnpm device:revoke --label "<label>"`, `pnpm device:list`. All use `DATABASE_URL`, `device:add` also `PUBLIC_HOST`; each builds the API first, reads `.env` from `apps/api` and writes an `audit_log` row.
- `pnpm admin:create [--username <name>] [--reset]` (doc 03 §6, §7.4): adds an admin (username default `admin`) or, with `--reset`, sets a new password and clears a lock; the password (≥ 10 characters) is typed twice at a hidden prompt or piped as the first line of stdin, and is never printed. There is no built-in account: production's first admin is `pnpm admin:create --username admin` with a strong password. `pnpm admin:create --dev-default` (development only) creates `admin` / `admin123`, and only when `NODE_ENV` is `development` or `test` (put `NODE_ENV=development` in the dev `apps/api/.env`) and the connected database is `m100_dev` or `m100_test_*`; otherwise it refuses and writes nothing. The API never seeds an admin. Uses `DATABASE_URL`, builds the API first, reads `.env` from `apps/api`, writes an `audit_log` row. Admin API: `/v1/admin/auth/login|logout`, `/v1/admin/me`, `/v1/admin/me/password`; session cookie `m100_admin` (8 h, path `/v1/admin`), state changes need `X-Requested-With: m100-admin`.
- `pnpm sweep-photos [--dry-run]` (doc 02 §6.2, weekly, dry run first): deletes photos under `submissions/` and `_probe/` older than 24 hours that no `submission_photos` row points to, from the store of `PHOTO_STORE`; uses `DATABASE_URL`, builds the API first, reads `.env` from `apps/api` (the whole API configuration must be valid) and writes one `audit_log` row per real run.
- `pnpm backup [--kind daily|pre-upgrade]` (doc 03 §7.6): `pg_dump -Fc` with `MIGRATE_DATABASE_URL` into `BACKUP_DIR\<kind>\<yyyy-MM-dd_HHmmss>\` with `manifest.json` and `config\` (`.env`, `secrets\`, `caddy-data\` of the working directory), photos of a `disk` store added to `BACKUP_DIR\photos\`, then retention (14 daily + 12 monthly; pre-upgrade last 5); `PG_BIN` when `pg_dump` is not on `PATH`. `pnpm backup:restore --from <backup folder> --database <new name> [--keep] [--replace] [--photos <dir>]` restores into a new database (needs `ADMIN_DATABASE_URL`), checks counts and photo files against the manifest and drops it unless `--keep`. Both build the API first and read `.env` from `apps/api`. On the server: `deploy\windows\m100.ps1 backup`, `restore.ps1`.
- `pnpm release [--skip-build]` (T4.1, Windows x64 only): `release/<version>/` and `release/m100-<yyyy.MM.dd>-<sha>[-dirty].zip` for `install.ps1` / `upgrade.ps1` (gitignored). Server scripts: `deploy\windows\precheck.ps1 -BackupDir <dir>` (TQ-5 checks, changes nothing), `install.ps1`, `upgrade.ps1 -Release <zip>` / `-Rollback`, `restore.ps1 -From <backup folder> [-Full]`, `m100.ps1 <command>`; see doc 03 §7.4, §7.6 "As built".
- `pnpm test` (Vitest in `web`, `admin`, `@m100/shared` and `deploy`, Jest in `api`; `deploy`'s PowerShell tests run on Windows only and `caddy validate` only with `CADDY_BIN`; the API's `backup.db.spec.ts` is skipped without `pg_dump`/`pg_restore` on `PATH` or in `PG_BIN`), `pnpm lint`, `pnpm typecheck`, `pnpm e2e`. The `S3PhotoStore` tests (contract suite and sweep) run only when `TEST_S3_ENDPOINT` is set (environment or `apps/api/.env`; optional `TEST_S3_ACCESS_KEY`, `TEST_S3_SECRET_KEY`), against a throw-away container: `docker run --rm -d --name m100-s3 -p 127.0.0.1:8333:8333 chrislusf/seaweedfs:4.48 server -s3` and `TEST_S3_ENDPOINT=http://127.0.0.1:8333`; each test file makes and removes its own `m100-test-*` buckets; `docker stop m100-s3` afterwards. The API's `*.db.spec.ts` tests need `TEST_ADMIN_DATABASE_URL` (a local PostgreSQL superuser, dev only) in `apps/api/.env` or the environment; each test file creates and drops its own `m100_test_*` database. A worktree has its own `apps/api/.env`. `import-master.real.db.spec.ts` (T2.4 on the real exports) is skipped unless `MASTER_DATA_DIR` names the folder of the exports.
- `pnpm test:load` (T3.7; not part of `pnpm test`): builds the API, then runs `apps/api/src/**/*.load.spec.ts` against the built API as its own process on a throw-away `m100_test_*` database (needs `TEST_ADMIN_DATABASE_URL`, as the `*.db.spec.ts` tests): the load test (`LOAD_TABLETS` tablets, default 50, one PSI lv.2 submission with five photos of `LOAD_PHOTO_KB`, default 200, each; all at once, then spread over `LOAD_WINDOW_SECONDS`, default 300) and the fault test (the database refuses connections for `FAULT_OUTAGE_SECONDS`, default 600, while the tablets send and seal more). About 25 minutes with the defaults; `LOAD_WINDOW_SECONDS=20 FAULT_OUTAGE_SECONDS=60 pnpm test:load` for a quick check. Each scenario prints its figures (p50/p95/max per submission, answers by status) and the path of its JSON report in the system temp folder.
- `pnpm e2e` runs against the real API: global setup builds the API, creates a throw-away `m100_test_e2e_*` database with `TEST_ADMIN_DATABASE_URL` (as the `*.db.spec.ts` tests), migrates it, imports the web fixtures (`apps/web/src/data/fixtures/`) and starts the API on `E2E_API_PORT` (default 3100); each test registers its own tablet through `/setup#k=`. It also builds the web app and serves it with `vite preview` on `http://localhost:4173` for the `pwa` project (service worker, install, offline); the default project `tablet-landscape` uses the dev server. Both proxy `/v1` to that API. `pnpm --filter web e2e --project pwa` runs only the PWA tests; `E2E_SKIP_API_BUILD=1` skips the API build when `apps/api/dist` is current.
- `pnpm e2e` then runs the admin app's tests (`pnpm --filter admin e2e` alone): the same global setup (`apps/web/e2e/api/testApi.ts`) on its own database, plus a first admin `e2e-root` made with `admin:create`; the API on `E2E_API_PORT` (default 3102 here) and the admin dev server on `E2E_ADMIN_PORT` (default 5176, not the 5175 of `pnpm dev:admin`, which proxies to the dev API). Each test makes its own admin account through `POST /admin/admins` and sends its own `X-Forwarded-For`, because the API allows 60 requests a minute per client IP for admin calls (300 for a signed-in admin's photo downloads, a separate budget; doc 03 §5.6).
- `E2E_PORT=5174 E2E_PREVIEW_PORT=4174 E2E_API_PORT=3101 pnpm e2e` from a git worktree when another checkout's dev server holds 5173, its preview 4173 or its e2e API 3100 (Playwright would otherwise reuse that dev server and test the other checkout's code)
- `pnpm format` / `pnpm format:check` (Prettier)
- `pnpm build` (shared → `packages/shared/dist`, web → `apps/web/dist`, admin → `apps/admin/dist` for `/admin/`, api → `apps/api/dist`)
- One package only: `pnpm --filter <web|admin|api|@m100/shared> <script>`
