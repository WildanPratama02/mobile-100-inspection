# Mobile 100% Inspection — Implementation Plan (draft v0.6)

| | |
|---|---|
| Status | **Draft.** Rewritten for PostgreSQL + photo store + admin app (ADR-018). Phases 0–4 are ready to build (docs 01–05, 07 exist). HTTPS (ADR-016) and the server (Windows, QIP Digital) are decided. The photo store is a plain folder for release 1 (TQ-6 decided); open before Phase 4: the server pre-checks (TQ-5). v0.6 adds Phase 5: Qty Inspection entered by the PSI (ADR-019). Tasks of Phases 0–3b that mention NO DEFECT or the ADR-008 table describe what was built then; Phase 5 changes it. |
| Executed by | Claude Code, one task per session, following `CLAUDE.md` |
| Last updated | 27 Oct 2026 |

## How to use this plan

- Do tasks in order. A task is **done** when every acceptance check listed under it passes and the commands in `CLAUDE.md` → Commands are green.
- Each task names the requirements it covers (FR / AC / BR / NFR from `docs/01-prd.md`). If a task and the PRD disagree, the PRD wins.
- A task marked **Blocked** must not be started. Report the blocker instead.

## Phase 0 — Foundation

### T0.1 Scaffold the monorepo
pnpm workspace with `apps/web` (React 18 + TS + Vite + vite-plugin-pwa), `apps/api` (NestJS, empty module only), `apps/admin` (React + Vite, empty page), `packages/shared`, `db/migrations/`. ESLint, Prettier, Vitest, Playwright, strict TypeScript, `.env.example`, root scripts `dev`, `test`, `lint`, `typecheck`, `e2e`.
- [ ] `pnpm install && pnpm typecheck && pnpm test && pnpm lint` all pass on a clean clone.
- [ ] `pnpm dev` serves a blank page titled "Mobile 100% Inspection".
- [ ] `CLAUDE.md` → Commands updated with the real commands.

### T0.2 Shared domain model and mapping
In `packages/shared`: types for User, Cell, PO, Area, SubArea, Family, Defect, Session, Inspection, Finding; a loader that reads `reference/mapping/mapping.json` into typed lookups.
- [ ] Tests: 12 areas (A01–A12); 98 defects (D001–D098); D049 and D071 both exist with the same name; Medial Quarter offers the same defects as Lateral Quarter (AC-07.1).

### T0.3 Counting engine (BR-01, BR-02, BR-05, FR-08 UNDO)
Pure functions in `packages/shared`: `startInspection(type)`, `noDefect()`, `recordDefect(...)`, `endInspection()`, `undo()`, `totals(session)`, `top5(session)`.
- [ ] Unit tests reproduce every row of the ADR-008 table.
- [ ] A B-GRADE pair with two defects adds 2 to Qty B-Grade.
- [ ] Rates are one decimal and "—" when Qty Inspection is 0.
- [ ] UNDO follows the four cases of FR-08 exactly and never reaches an ended inspection.
- [ ] Top 5 tie order: CRITICAL > MAJOR > MINOR, then first recorded (AC-05.1).

### T0.4 Design tokens and UI kit
Import `design-system/tokens.css` (with self-hosted fonts instead of the Google `@import`). Port the design-system components to `apps/web/src/ui/` with the props in `design-system/components/index.d.ts`. Light and dark themes.
- [ ] A dev-only `/ui` page shows every component in every state from its README.
- [ ] No hex colour in `apps/web/src` outside `tokens.css` (lint rule or test).
- [ ] Every tappable element ≥ 44 × 44 px (Playwright check on `/ui`).
- [ ] `ShoeMap` renders `erasebg-transformed.avif` with 12 pills; pill positions match the design-system preview.

## Phase 1 — Offline PWA with local data (no backend)

Master data comes from a `MasterDataSource` interface. Phase 1 implements it with local fixtures (`apps/web/src/data/fixtures/`: a few fake PSI users of both levels, two factories with cells, ~10 fake POs); Phase 2 swaps in the API implementation without changing screens. Fixtures must not contain real names from the old `USER_LIST`.

### T1.1 Persistence
Dexie schema for login, PO list, sessions (per user, per PO), photos and outbox. Zustand store hydrated from Dexie.
- [ ] Every change is written to IndexedDB before the UI shows it (NFR-05); a reload mid-inspection restores everything (AC-06.2).
- [ ] Sessions are scoped to the user (AC-02.3).

### T1.2 Login and logout (FR-01, FR-02)
- [ ] AC-01.1 … AC-01.4 and AC-02.1 … AC-02.3, using fixtures.

### T1.3 Home: PO list, Add PO, results panel, Top 5 (FR-03, FR-04, FR-05; doc 05 S3, S4, S5)
- [ ] AC-03.1 … AC-03.7 (including PO PARTIAL with the in-app number pad), AC-04.1 … AC-04.2, AC-05.1 … AC-05.2.
- [ ] Layout follows the prototype; styling follows the design system.

### T1.4 Defect screen (FR-06, FR-07, FR-08, FR-09)
Commands, ShoeMap, drill-down with auto-skip (BR-08), breadcrumb, history, BACK / HOME / UNDO.
- [ ] AC-06.1 … AC-06.3, AC-07.1 … AC-07.3, AC-08.1, AC-09.1 … AC-09.2.
- [ ] Tap feedback within 100 ms (NFR-03).

### T1.5 Photos (FR-10)
Camera via `<input type="file" accept="image/*" capture="environment">`, resize to ≤ 960 px JPEG on the tablet, store in IndexedDB.
- [ ] AC-10.1 … AC-10.6: PSI lv.2 only, exactly one photo per Top 5 defect; no photo UI and no photos at all for PSI lv.1.

### T1.6 Export PDF and Excel (FR-12)
- [ ] AC-12.1 … AC-12.4.

### T1.7 Submit PO, local half (FR-11 steps 1–3)
Pre-checks, confirmation dialog, sealing the session with a UUID into the outbox, new empty session. Sending is a stub that leaves items "waiting".
- [ ] Every pre-check message from FR-11.1; BR-04 for PSI lv.2.
- [ ] Outbox list and waiting count in the header (AC-11.3).

### T1.8 PWA and end-to-end tests
- [ ] Installable; after first load the whole Phase 1 flow works with the network off (NFR-04).
- [ ] Playwright covers: login → add PO → REWORK with 2 defects → END → B-GRADE with 1 defect → NO DEFECT → UNDO → submit to outbox, checking every number on Home.
- [ ] Layouts Regular, Compact and Stacked from `design-system/README.md` checked at 1280×800, 915×412 and 800×1280.

## Before Phase 2 — what the product owner prepares (not Claude's work)

1. **Master data files** exported from the old spreadsheet (File → Download → CSV/XLSX), kept out of the repo's public history: `USER_LIST`, `DB_CELL`, `ALL_PO_MASTER`, `DEFECT_LIST` and the area-mapping workbook (`reference/mapping/` already holds the mapping). They are imported once (T2.4). No Google Cloud project, service account or OAuth is needed any more.
2. **A development PostgreSQL 16** (local Windows service or Docker on the developer machine) with an empty database `m100_dev` and the roles of doc 03 §6 (`m100_app`, `m100_migrate`, `m100_report`). The `.env` has `DATABASE_URL` and `MIGRATE_DATABASE_URL`.
3. **A photo folder** for development (`PHOTO_STORE=disk`, `PHOTO_DIR`). The S3 variant (T3.4) is optional for release 1 and is tested against a throw-away S3-compatible container; it is not deployed.

## Phase 2 — Database, API and master data · Ready

Spec: doc 02 (all), doc 03 §5, doc 04 §2–3, §8.

### T2.1 API skeleton
NestJS app with validated configuration (doc 03 §7.4), pino logging with `X-Request-Id`, `GET /health`, a global filter that returns `application/problem+json` with the codes of doc 04 §6, a throttler of 60 requests per minute per device, and a test helper that validates responses against `docs/04-openapi.yaml`.
- [ ] A missing environment variable stops the process and names the variable.
- [ ] The 61st request in a minute from one device gets `429 RATE_LIMITED` with `Retry-After`.
- [ ] An unknown route returns problem+json, not HTML.

### T2.2 Schema and migrations
`db/migrations/` as explicit SQL (no auto-sync): every table, constraint, index, trigger and view of doc 02 §3–§8, extension `pg_trgm`, roles and grants (doc 03 §6), `settings` rows. A `pnpm db:migrate` command using `MIGRATE_DATABASE_URL`; a test database is created per test run.
- [ ] Migrations apply to an empty database and are recorded; running them again changes nothing.
- [ ] The immutability trigger: every UPDATE and DELETE on submissions, findings and photos fails.
- [ ] The check constraints reject a submission whose totals disagree with its counts (doc 02 §4.1).
- [ ] `m100_report` can SELECT the views and nothing else; `m100_app` cannot DELETE from submission tables.

### T2.3 Repositories and the PhotoStore
Postgres repositories for master data, POs, devices, admins, audit log and submissions; `PhotoStore` interface with `DiskPhotoStore` (doc 03 §5.2).
- [ ] Repository tests run against the real test database.
- [ ] `DiskPhotoStore.put` is atomic (temp file + rename), idempotent for the same key and bytes, and refuses a key that escapes `PHOTO_DIR`.

### T2.4 Master data import (`import-master`) and readiness
The CLI `import-master` (doc 02 §5.1) for users, factories/cells, POs, defects and area map, with `--dry-run`; the cached `/master-data` with ETag (`settings.master_version`); readiness checks `DB`, `MASTER_DATA`, `PHOTO_STORE`, `SUBMIT_ENABLED` and `/system/status` (doc 02 §10, doc 03 §5.3).
- [ ] From the real files: 14 login names, `ROIS FATHUR ROHIM` once, `EVA JULIYANI` as PSI lv.1 only, factories `F 1`…`F 5` (no `PWA`, no `BOTTOM`), 98 defects, 437 map rows; `ALL_PO_MASTER` 34,230 non-empty rows giving 33,996 POs (3 identical duplicates merged, 91 conflicting PO numbers with 231 rows skipped, doc 02 §5.1; export of 21 Oct 2026); a second run changes nothing.
- [ ] A dry run writes nothing and reports counts; any invalid row stops the real run before any write.
- [ ] Stopping the database sets `SUBMIT_ENABLED` false with the failing check id; starting it re-enables within 30 seconds.

### T2.5 Devices and authentication
Device guard (SHA-256 lookup, constant-time compare); `POST /auth/login`, `POST /auth/refresh`; 30-day JWT with `aud`=`tablet` and the claims of doc 04 §2; CLI `device:add` (single and `--batch`) that prints key, setup link and a QR code, `device:revoke` and `device:list`; each writes an `audit_log` row.
- [ ] Only the SHA-256 of a key is stored. A revoked device is rejected with `DEVICE_KEY_INVALID` even with an unexpired token.
- [ ] `USER_NOT_FOUND` and `CELL_NOT_FOUND` as `422`; refresh works when fewer than 7 days remain.
- [ ] A batch of 40 unique labels creates 40 keys and one printable sheet; a duplicate label is refused.

### T2.6 PO search
`GET /pos`, `GET /pos/{po}` (doc 04 §3.3) with `pg_trgm`.
- [ ] Fewer than 3 characters → `422`; at most 20 results; leading zeros and prefixes kept (`0902028839`, `CX-0902368685`); `model` and `destination` returned byte for byte.
- [ ] Over the full imported PO set: p95 under 100 ms.

### T2.7 Web: switch from fixtures to the API
`ApiMasterDataSource`, the setup page (doc 03 §4.9), login against the API, token refresh, PO search through the API, cache behaviour.
- [ ] AC-01.1 … AC-01.4 and AC-13.1 … AC-13.4 against the API on `localhost` and the test database.
- [ ] The setup link stores the key and removes the fragment from the address.
- [ ] After one online launch the app starts, logs in from cache and works with the network off.

## Phase 3 — Submit PO · Ready

Spec: doc 02 §4, §6–8, doc 03 §5.4–5.8, doc 04 §4–5. All against the real test database.

### T3.1 Pure functions
`computeTotals`, `top5`, `photoKey`, `partialText`, `inspectionDate` (doc 03 §5.5).
- [ ] The doc 02 §9 example gives Qty Inspection 30, A-Grade 18, B-Grade 3, Qty Defect 11, RFT 0,600, Defect Rate 0,367.
- [ ] `top5` on the API equals `top5` on the tablet for the same findings (shared package).
- [ ] `P1 1.200 OF 10.002` formatting; `photoKey` uses the WIB month.

### T3.2 Request parsing and validation
Multipart parsing with limits, and every check of doc 04 §4.2 with the error shapes of doc 04 §6.
- [ ] One test per check; all failures returned together in one `VALIDATION_FAILED`; `PHOTO_MISSING` lists the defects; `PHOTO_NOT_ALLOWED` for PSI lv.1; `413` over 8 MB; a non-JPEG part is refused; counts that disagree with the findings are refused (the request carries no totals, doc 04 §4.1; a `totals` field is an unknown field).

### T3.3 Submission write
`POST /submissions` as in doc 02 §6.1 / doc 03 §5.4: UUID lookup, validation at `REPEATABLE READ`, photos first, one transaction, `201`/`200`/`409`.
- [ ] Same UUID and bytes twice (also in parallel) → one submission, one answer `201` and the others `200`. Same UUID and different bytes → `409 SUBMISSION_UUID_REUSED`, nothing written.
- [ ] A fake store that throws after two photos, and a failure injected before commit: the retry leaves exactly one submission, one set of findings, and one file per photo; no submission row ever points to a missing file.
- [ ] Snapshot columns (factory, cell, PO fields, defect names and severity) equal the master data at write time and do not change when master data is edited afterwards.
- [ ] Database down → `503 DB_UNAVAILABLE`; store down → `503 PHOTO_STORE_UNAVAILABLE`; `SUBMIT_ENABLED` false → `503 SUBMIT_DISABLED`; submission log line (NFR-10).

### T3.4 S3 PhotoStore (optional, can be postponed)
`S3PhotoStore` (`@aws-sdk/client-s3`, path-style) and the weekly orphan sweep CLI `sweep-photos` (`--dry-run`).
- [ ] The same photo-store test suite passes for disk and S3 implementations.
- [ ] The sweep removes only objects older than 24 hours without a `submission_photos` row.

### T3.5 Web: sealing and the outbox sender
The seal transaction, the sender loop following doc 04 §5 exactly (synchronous answers, 60 s timeout), the four states, the header counter and the gear-menu list (doc 03 §4.6).
- [ ] AC-11.1 … AC-11.4 against a stub API.
- [ ] Wi-Fi off → submit → close app → Wi-Fi on → reopen: exactly one submission sent (AC-11.2).
- [ ] Every row of the doc 04 §5 table has a test, including a timeout followed by a resend of the same bytes that gets `200`.
- [ ] Two PSI on one tablet: A seals, logs out, B logs in; A's submission is sent under A's name.

### T3.6 End-to-end
Playwright: web against the real API process and database.
- [ ] PSI lv.2 flow with five photos produces the expected submission, findings and photo files; PSI lv.1 flow produces no photos.
- [ ] PO PARTIAL on and off stores the right partial (AC-03.7).

### T3.7 Load and fault tests
- [ ] 50 simulated tablets, five photos each, within 5 minutes: no loss, no duplicate; p95 per submission reported.
- [ ] Database stopped for 10 minutes, then started: every submission ends stored exactly once.

## Phase 3b — Admin web app · Ready (can run parallel to Phase 3)

Spec: PRD FR-14, doc 05 §20, doc 04 §8.

### T3b.1 Admin API and authentication
`AdminModule`: login (argon2id, lockout, cookie JWT `aud`=`admin`, `X-Requested-With` check), logout, `/admin/me`, CLI `admin:create` (also `--reset`), audit-log writing for every change.
- [ ] 5 wrong passwords lock the account 10 minutes (`ADMIN_LOCKED`); a tablet token is refused on admin endpoints and the reverse.
- [ ] A state-changing request without the header is refused; every change appears in `audit_log` with admin, target and summary.
- [ ] The last active admin cannot be deactivated.

### T3b.2 Master data CRUD and imports
PSI users, factories/cells, POs, defects/area map endpoints; imports with `dryRun`; each change bumps `master_version`.
- [ ] Duplicate natural keys → `409 CONFLICT`; an import with any invalid row applies nothing (AC-14.3).
- [ ] After a change, `/master-data` returns a new ETag (AC-14.1); deactivated rows disappear from `/master-data` but stay readable on old submissions (AC-14.2).

### T3b.3 Submissions endpoints (read-only)
Submissions list/detail/photos/export.csv, admins CRUD, audit-log read.
- [ ] No endpoint changes a submission (AC-14.4); the database rejects a manual UPDATE or DELETE.
- [ ] CSV export matches the filter, uses UTF-8 with BOM, a comma for lists and a dot for decimals in raw columns (documented), and the photo endpoint returns the JPEG only to an admin.

### T3b.4 Admin web screens
`apps/admin` with the screens A0–A7 of doc 05 §20 and the 3-step import flow.
- [ ] Each screen's states (loading, empty, error, saved) are reproducible in Playwright; login lockout and the 3-step import are covered.
- [ ] Keyboard-only use works; touch targets ≥ 44 px.

## Phase 4 — Deploy and pilot · Ready after the server pre-checks (doc 03 §7.3, TQ-5)

### T4.1 Deployment files
PowerShell `install.ps1` and `upgrade.ps1`, WinSW service definitions for Caddy (with the Cloudflare DNS module) and the API, PostgreSQL installation and database/role creation, the `Caddyfile` for `m100.qdms.web.id` including `/admin/` (doc 03 §7.2.1), the Windows Firewall rule, cache headers and CSP, the nightly backup task (`pg_dump` + photo copy, retention 14 daily / 12 monthly), and a restore script. No bash scripts: the server is Windows.
- [ ] On a clean Windows VM, `install.ps1` leaves all services running in the right order (PostgreSQL before the API); they come back after a reboot; `upgrade.ps1` takes a dump, runs migrations, switches release and a rollback restores the previous code; logs rotate.
- [ ] Caddy obtains a Let's Encrypt certificate through the Cloudflare DNS challenge, and `https://m100.qdms.web.id/v1/health` and `/admin/` open from the factory Wi-Fi without a warning.
- [ ] **Restore test:** the nightly backup is restored on another machine; submission counts match and sample photos open (doc 03 §7.6).

### T4.2 Device checklist on a real Redmi Pad 2
Install, setup-link storage visible in the installed app, camera `capture`, offline start, certificate trust, 1280 × 800 layout (doc 03 R8, R9).
- [ ] Every item passes, or the fallback of doc 03 §4.9 is applied.

### T4.3 Runbook and PSI instruction card
Cloudflare and DNS setup (doc 03 §7.2.1), domain renewal date and account owners, server install, `.env` and secrets, initial `admin:create` and `import-master`, tablet setup, backup and restore, upgrade, revoke, troubleshooting, and a one-page card for PSI ("never clear site data while submissions are waiting").
- [ ] A person who did not write the runbook reinstalls the system on a clean server from it and restores a backup.

### T4.4 Pilot
One or two tablets in production for a defined period. The old AppSheet process continues separately; the pilot compares totals for the same POs by hand (OQ-05, OQ-13).
- [ ] Goals G1–G5 of the PRD are met over the pilot period; a go / no-go note is written.

### T4.5 Rollout to all tablets
Device keys in batch, setup of every tablet (doc 03 §7.5), the PSI instruction card handed out, the waiting counters watched during the first week.
- [ ] Every tablet shows "Tablet terdaftar", lets a PSI log in, and has completed one test submission checked in the admin app.

## Phase 5 — Qty Inspection entered by the PSI (ADR-019) · Ready

A change request of 27 Oct 2026 (revised 28 Oct 2026) to code that is already built (T0.3, T1.3, T1.4, T1.7, T2.2, T3.1–T3.3, T3.5, T3b.3, T3b.4). Qty Inspection is entered on Home with the number pad; NO DEFECT disappears; **Qty Defect counts findings and Qty A-Grade = Qty Inspection − Qty Defect**; limits BR-10 (≥ 1, ≥ Qty Defect, ≤ partial / Qty Order); Qty A-Grade `0` and rates `0,0%` while Qty Inspection is empty or not valid. Specs: ADR-019 (decisions 1–9); PRD v0.7 FR-04, FR-06, FR-08, FR-11, **FR-15**, BR-01, BR-02, **BR-10**; doc 02 v2.1 §4.1, §6.3, §9; doc 04 v2.1 §4.1, §4.2, A17; doc 03 v0.4 §4.2, §5.5; doc 05 v0.3 §8, **§10b (S5b)**, §11, §13.1, §15, U20–U22. Do the tasks in order on one feature branch; T5.1–T5.3 ship in one release (the API accepts both payload shapes, so tablets that have not updated yet keep working). Merge only after T5.1–T5.4 and the full regression (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm e2e`) are green. Recommended before T4.4, so the pilot runs with the counting the PSI will keep.

### T5.1 Shared counting engine and limits (`packages/shared`)
Replace the ADR-008 counting with ADR-019: the `SET_QTY_INSPECTION{qty}` event, `noDefect()` removed, `totals(state, po)`, `qtyInspectionLimits(qtyDefect, partial, orderQty)`, `checkQtyInspection`, `computeTotals(counts, findings)` for both payload shapes, `countingRule(counts)` (doc 03 §5.5). Type-only shims elsewhere keep `pnpm typecheck` green; web and API behaviour tests that encode ADR-008 are rewritten in T5.2/T5.3.
- [ ] **Regression:** one REWORK pair with three findings raises Qty Defect by exactly 3 (not 1) and lowers Qty A-Grade by 3; likewise B-GRADE (Qty B-Grade +3).
- [ ] Unit tests reproduce every row of the ADR-019 table; the doc 02 §9 example (Qty Inspection 30, 10 REWORK pairs with 8 findings, 2 B-GRADE pairs with 3 findings) gives Qty Defect 11, B-Grade 3, A-Grade 19, RFT 0,633, Defect Rate 0,367, rule `ADR-019`.
- [ ] Qty Inspection empty, below Qty Defect or above the maximum → Qty A-Grade, Defect Rate and Pass Rate `null` (shown as `0` / `0,0%`), Qty Defect and Qty B-Grade still counted.
- [ ] `qtyInspectionLimits`: min = max(1, Qty Defect); max = partial qty when set, else Qty Order. `checkQtyInspection` gives `IMPOSSIBLE` for Qty Defect > Qty Order, Qty Defect > partial qty and any min > max; then no value is accepted and no finding is removed.
- [ ] Recording a finding is never refused because of Qty Inspection; the last `SET_QTY_INSPECTION` wins; a SET never changes the UNDO history; UNDO follows FR-08 (two cases) and never changes Qty Inspection; a `NO_DEFECT` event left in an old session is ignored on replay.
- [ ] `computeTotals` with `{ rework, bGrade, noDefect }` still gives the ADR-008 figures and rule `ADR-008`; with `qtyInspection` it gives the ADR-019 figures and rule `ADR-019`.

### T5.2 Database and API (migration 0006, submission write, admin read)
Migration `0006` exactly as doc 02 §4.1 "Migration 0006"; the submission schema and checks of doc 04 §4.1–§4.2 (rule 3); the write stores `counting_rule`; the admin list, detail and CSV carry `countingRule` and the new `counts` (A17).
- [x] On a database that holds ADR-008 submissions, `pnpm db:migrate` applies 0006, every old row reads `counting_rule = 'ADR-008'` with its numbers unchanged, and the immutability trigger is still in place; a second run applies nothing.
- [x] The checks reject an ADR-019 row with `qty_no_defect` set, `qty_a_grade` ≠ `qty_inspection − qty_defect`, `qty_inspection` below `qty_defect` or above `COALESCE(partial_qty, order_qty)`; they accept a valid ADR-019 row and still accept an ADR-008 row with its original figures.
- [x] `POST /submissions` validates on its own (never trusting the tablet): one test per rule-3 failure (both or neither of `qtyInspection`/`noDefect`, not a positive integer, below Qty Defect, above the partial, above `ORDER QTY`, Qty Defect above the maximum), each `422 VALIDATION_FAILED` with path `counts.qtyInspection`; the stored totals equal the server's own calculation (A-Grade = Qty Inspection − Qty Defect) and pass the database re-check; a valid ADR-019 payload is stored with `counting_rule = 'ADR-019'` and `qty_no_defect` null; an ADR-008 payload (sealed by the old app) is stored with `'ADR-008'` and the ADR-008 figures.
- [x] The views and the CSV export show `counting_rule` from the row; `qty_no_defect` is empty for ADR-019 rows.

### T5.3 Tablet app (web)
Home: QTY INSPECTION row tappable (`StatRow onClick`, U20), dialog S5b with `NumberPad min` (U21), results and notices of §8.1–§8.2. Defect screen: NO DEFECT gone (§11.1–§11.2), UNDO cases (§11.4). Submit PO: the Qty Inspection checks of §13.1; sealing writes `counts.qtyInspection`. Exports show the same seven values as Home. Port the two new optional props into `design-system/components` (index.d.ts, README, bundle) and `apps/web/src/ui` with the same names.
- [x] S5b: SIMPAN disabled outside `min`…`max` with the NumberPad message; SIMPAN stores the event before closing; the value survives a reload and belongs to the selected PO only (AC-15.1 … AC-15.4).
- [x] Each row of the §8.2 state table and each new row of §13.1 has a test; the `/ui` catalogue shows `StatRow` with `onClick` and `NumberPad` with `min`; every tappable element is ≥ 44 × 44 px.
- [x] Home shows Qty A-Grade `0` and both rates `0,0%` while Qty Inspection is empty or not valid; Qty Defect and Qty B-Grade always show the findings; a finding recorded after Qty Inspection makes it not valid without blocking the tap.
- [x] Playwright covers: login → add PO with partial → REWORK with 2 defects → END → B-GRADE with 1 defect → END → UNDO disabled → Home shows A-Grade 0, rates 0,0% → QTY INSPECTION 2 refused (below 3 defects) → QTY INSPECTION 30 → Home shows A-Grade 27, Defect Rate 10,0%, Pass Rate 90,0% → submit; the stored submission has Qty Inspection 30, Qty Defect 3, A-Grade 27 and `counting_rule = 'ADR-019'`.
- [x] An outbox item sealed before the update (fixture with `noDefect`) is sent unchanged and stored as ADR-008.

### T5.4 Admin app
A1 list and A1b detail show the counting rule and the counts (doc 05 §20.3).
- [x] The detail of an ADR-019 submission shows Qty Inspection, REWORK and B-GRADE pairs and "Qty Inspection diisi PSI"; an ADR-008 one shows its NO DEFECT count and "Hitung per tap (lama)".
- [x] The admin Playwright tests pass with both kinds of submission in the database.
