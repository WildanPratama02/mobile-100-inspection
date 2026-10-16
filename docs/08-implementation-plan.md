# Mobile 100% Inspection — Implementation Plan (draft v0.4)

| | |
|---|---|
| Status | **Draft.** Phases 0–4 are ready to build (docs 01, 02, 03, 04, 07 exist). HTTPS (ADR-016) and the server (Windows, operated by QIP Digital) are decided; Phase 4 starts with the server pre-checks of doc 03 §7.3 (TQ-5). |
| Executed by | Claude Code, one task per session, following `CLAUDE.md` |
| Last updated | 16 Oct 2026 |

## How to use this plan

- Do tasks in order. A task is **done** when every acceptance check listed under it passes and the commands in `CLAUDE.md` → Commands are green.
- Each task names the requirements it covers (FR / AC / BR / NFR from `docs/01-prd.md`). If a task and the PRD disagree, the PRD wins.
- A task marked **Blocked** must not be started. Report the blocker instead.

## Phase 0 — Foundation

### T0.1 Scaffold the monorepo
pnpm workspace with `apps/web` (React 18 + TS + Vite + vite-plugin-pwa), `apps/api` (NestJS, empty module only), `packages/shared`. ESLint, Prettier, Vitest, Playwright, strict TypeScript, `.env.example`, root scripts `dev`, `test`, `lint`, `typecheck`, `e2e`.
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

Master data comes from a `MasterDataSource` interface. Phase 1 implements it with local fixtures (`apps/web/src/data/fixtures/`: a few fake PSI users of both levels, two factories with cells, ~10 fake POs); Phase 2 swaps in the API implementation without changing screens. Fixtures must not contain real names from `USER_LIST`.

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

1. A **copy** of the spreadsheet "100%INLINE IMPACTIVA" (File → Make a copy), used for all development and tests. Its ID goes in `.env` as `SHEET_ID`.
2. A Google Cloud project with the Sheets API and Drive API enabled, a **service account** with a JSON key (saved in `secrets/`), and the copy shared with the service account's e-mail as Editor.
3. A **test Drive folder** (ID in `DRIVE_IMAGES_FOLDER_ID`) owned by `fnd.ahmad12@gmail.com`.
4. Before T3.5 only: an OAuth client (desktop type) in the same project, with the consent screen set to **In production** (doc 03 §6), and the owner's consent for the `drive` scope.

## Phase 2 — API and master data (read-only) · Ready

Read-only against the **copy**. Spec: doc 03 §5, doc 04 §2–3, doc 02 §3, §10.

### T2.1 API skeleton
NestJS app with validated configuration (doc 03 §7.4), pino logging with `X-Request-Id`, `GET /health`, a global filter that returns `application/problem+json` with the codes of doc 04 §6, a throttler of 60 requests per minute per device, and a test helper that validates responses against `docs/04-openapi.yaml`.
- [ ] A missing environment variable stops the process and names the variable.
- [ ] The 61st request in a minute from one device gets `429 RATE_LIMITED` with `Retry-After`.
- [ ] An unknown route returns problem+json, not HTML.

### T2.2 Repositories, Google clients and fakes
Read-side repository interfaces of doc 03 §5.2, `SheetsClient` with the retry/back-off helper (doc 03 §5.7), in-memory fakes that can inject 429, timeouts and crashes, and the script `setup:sheets` that creates `M100_AREA_MAP`, `M100_DEFECT_DETAIL` and `M100_SUBMISSION` in the copy from `reference/mapping/` (doc 02 §4).
- [ ] Back-off: `429` waits 2^n s plus jitter up to 1 s, capped at 32 s; `5xx` is retried; `400` is not.
- [ ] `setup:sheets --dry-run` lists the sheets, columns and row counts (437 map rows) and writes nothing; the real run refuses a sheet that already exists with other headers and never runs against a spreadsheet other than `SHEET_ID`.

### T2.3 Master data, start-up checks, `/master-data`, `/system/status`
Doc 02 §3 and §10; cache with ETag and `304`; checks `HEADERS`, `DEFECT_LIST`, `AREA_MAP`, `LINK_TEMPLATES`, `DRIVE_ACCESS`, `SHEETS_ACCESS`; re-check every 30 minutes and every 2 minutes while disabled.
- [ ] Against the copy: 14 login names, `ROIS FATHUR ROHIM` once, `EVA JULIYANI` as PSI lv.1 only, factories `F 1`…`F 5` (no `PWA`, no `BOTTOM`).
- [ ] Renaming one header in the fake sets `submitEnabled=false` with the failing check id; restoring it re-enables within 2 minutes.
- [ ] A failed refresh keeps serving the last good copy.

### T2.4 Devices and authentication
`devices.json` loader that reloads on change; scripts `device:add`, `device:revoke`, `device:list` (the first prints the key, the setup link and a QR code; `device:add --batch tablets.csv` creates many keys and one printable sheet of QR codes; doc 03 §7.5); device guard; `POST /auth/login`, `POST /auth/refresh`; 30-day JWT with the claims of doc 04 §2.
- [ ] Only the SHA-256 of a key is stored. A revoked device is rejected with `DEVICE_KEY_INVALID` even with an unexpired token.
- [ ] `USER_NOT_FOUND` and `CELL_NOT_FOUND` as `422`; refresh works when fewer than 7 days remain.
- [ ] A batch of 40 unique labels creates 40 keys and one printable sheet; a duplicate label is refused.

### T2.5 PO index and search
`GET /pos`, `GET /pos/{po}` (doc 04 §3.3, doc 03 §5.3).
- [ ] Fewer than 3 characters → `422`; at most 20 results; leading zeros and prefixes kept (`0902028839`, `CX-0902368685`); `MODEL` and `DESTINATION` returned byte for byte.
- [ ] Search over a synthetic 71,500-row index: p95 under 50 ms.

### T2.6 Web: switch from fixtures to the API
`ApiMasterDataSource`, the setup page (doc 03 §4.9), login against the API, token refresh, PO search through the API, cache behaviour.
- [ ] AC-01.1 … AC-01.4 and AC-13.1 … AC-13.4 against the API on `localhost` backed by fakes.
- [ ] The setup link stores the key and removes the fragment from the address.
- [ ] After one online launch the app starts, logs in from cache and works with the network off.

## Phase 3 — Submit PO to the spreadsheet · Ready

Spec: doc 03 §5.4–5.8, doc 02 §5–8, doc 04 §4–5. Build against the fakes first; the real copy comes last.

### T3.1 Slot planner and row builder (pure functions)
`computeTotals`, `planSlots`, `buildDataInspectionRow`, `buildCompleteRequest`, `photoFileName`, `submissionId`, `sheetDate`, `partialText` (doc 03 §5.5). Golden files are made from a real row of the **copy** with names replaced.
- [ ] The doc 02 §9 example gives `QTY INSPECTION` 30, `A-GRADE` 18, `B-GRADE` 3, `TOTAL DEFECT` 11, `RFT` 0.600, `DEFECT RATE` 0.367.
- [ ] The row has 276 cells in the order of doc 02 §5–6; unused slots follow doc 02 §6.5; D049 and D071 get separate slots.
- [ ] Slots 1–5 equal the tablet's `top5()` for the same findings.
- [ ] More than 25 defects: overflow only in the detail rows, `TOTAL DEFECT` still complete, photographed defects never overflow.
- [ ] PSI lv.2: `PHOTO` only in `PHOTO(3n−2)`; PSI lv.1: no `PHOTO` cell filled; `P1 1.200 OF 10.002` formatting.

### T3.2 Request parsing and validation
Multipart parsing with limits, and every check of doc 04 §4.2 with the error shapes of doc 04 §6.
- [ ] One test per check; all failures returned together in one `VALIDATION_FAILED`; `PHOTO_MISSING` lists the defects; `PHOTO_NOT_ALLOWED` for PSI lv.1; `413` over 8 MB; a non-JPEG part is refused.

### T3.3 Writer pipeline on the fakes
Steps 1–6 of doc 02 §8.2 with the fresh lookups and the verify read (doc 03 §5.4), one worker, 429 back-off.
- [ ] A crash injected after photos, after append, before and inside the batch: the retry always leaves exactly one `DATA_INSPECTION` row, one set of detail rows, one `M100_SUBMISSION` row and one file per photo.
- [ ] If the fake gives our row number to another writer first, the pipeline appends again and writes the formulas only to the verified row.

### T3.4 Submission endpoints and job registry
`POST /submissions` (`201`, `200`, `202` after 20 s), `GET /submissions/{uuid}` (including the `404` rule), `409 SUBMISSION_UUID_REUSED`, `503 SUBMIT_DISABLED`, submission log line (NFR-10).
- [ ] Same UUID and bytes twice → one row, second answer `200`. Same UUID and different bytes → `409`, nothing written.
- [ ] Slow fake (> 20 s) → `202`, then `written` through `GET`.
- [ ] After a simulated restart, `GET` of an unfinished UUID answers `404` and a resend completes it.

### T3.5 Google implementations: Sheets writes and Drive photos
`InspectionRepository` (append, verify read, `batchUpdate` with `copyPaste` formats, 75 LINK formulas from the templates, detail and submission rows) and `PhotoStore` with the owner's OAuth; the script `drive:authorize` that performs the one-time consent.
- [ ] (Manual, env-gated, on the copy and the test folder) The new row has the same formats and LINK formulas as the row above it, apart from the row number; the file exists with the exact name `<ID>.PHOTO<k>.<HHmmss>.jpg`; `M100_DEFECT_DETAIL` and `M100_SUBMISSION` rows exist.
- [ ] Revoking the OAuth token turns `DRIVE_ACCESS` red within 2 minutes and submissions answer `503 SUBMIT_DISABLED`.

### T3.6 Web: sealing and the outbox sender
The seal transaction, the sender loop following doc 04 §5 exactly, the four states, the header counter and the gear-menu list (doc 03 §4.6).
- [ ] AC-11.1 … AC-11.4 against a stub API.
- [ ] Wi-Fi off → submit → close app → Wi-Fi on → reopen: exactly one submission sent (AC-11.2).
- [ ] Every row of the doc 04 §5 table has a test, including `404` while Mengirim and a retryable `failed`.
- [ ] Two PSI on one tablet: A seals, logs out, B logs in; A's submission is sent under A's name.

### T3.7 End-to-end on the fakes
Playwright: web against the real API process backed by the fake Sheets and Drive.
- [ ] PSI lv.2 flow with five photos produces the expected row, detail rows and files; PSI lv.1 flow produces no photos.
- [ ] PO PARTIAL on and off writes the right `PARTIAL OF QTY PO` (AC-03.7).

### T3.8 Load and fault tests
- [ ] 50 simulated tablets, five photos each, within 5 minutes, with random `429`s: no loss, no duplicate; p95 per submission reported (doc 03 §5.4 says what to do if it exceeds 6 s).
- [ ] Google unavailable for 10 minutes, then back: every submission ends written exactly once.

## Phase 4 — Deploy and pilot · Ready after the server pre-checks (doc 03 §7.3, TQ-5); the parallel run also needs OQ-05

### T4.1 Deployment files
PowerShell `install.ps1` and `upgrade.ps1`, WinSW service definitions for Caddy (with the Cloudflare DNS module) and the API, the `Caddyfile` for `m100.qdms.web.id` (doc 03 §7.2.1), the Windows Firewall rule, cache headers and CSP (doc 03 §6–7). No bash scripts: the server is Windows.
- [ ] On a clean Windows VM, `install.ps1` leaves both services running; they come back after a reboot; `upgrade.ps1` switches release and a rollback restores the previous one; logs rotate.
- [ ] Caddy obtains a Let's Encrypt certificate for `m100.qdms.web.id` through the Cloudflare DNS challenge, and `https://m100.qdms.web.id/v1/health` opens from the factory Wi-Fi without a warning.

### T4.2 Device checklist on a real Redmi Pad 2
Install, setup-link storage visible in the installed app, camera `capture`, offline start, certificate trust, 1280 × 800 layout (doc 03 R8, R9).
- [ ] Every item passes, or the fallback of doc 03 §4.9 is applied.

### T4.3 Runbook and PSI instruction card
Cloudflare and DNS setup (doc 03 §7.2.1), domain renewal date and account owners, server install, secrets, Drive consent (consent screen **In production**), `device:add`, backup and restore, upgrade, revoke, troubleshooting, and a one-page card for PSI ("never clear site data while submissions are waiting").
- [ ] A person who did not write the runbook reinstalls the system on a clean server from it.

### T4.4 Pilot and parallel run
One or two tablets against the production spreadsheet, in parallel with the AppSheet app (OQ-05), compared daily.
- [ ] Goals G1–G5 of the PRD are met over the pilot period; a go / no-go note is written.

### T4.5 Rollout to all tablets
Device keys in batch, setup of every tablet (doc 03 §7.5), the PSI instruction card handed out, the waiting counters watched during the first week.
- [ ] Every tablet shows "Tablet terdaftar", lets a PSI log in, and has completed one test submission agreed with the sheet owner.
