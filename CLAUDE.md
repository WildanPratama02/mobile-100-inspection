# Mobile 100% Inspection (M100)

Tap-only tablet PWA for PSI lv.1 / lv.2 inspectors at PT Parkland World Indonesia to record footwear defects per PO. Results are written to the existing Google Sheet "100%INLINE IMPACTIVA" (shared with a live AppSheet app) through a NestJS API.

## Where the truth lives

Read the doc a task needs before writing code. Do not invent behaviour that a doc does not state.

| Need | Read |
|---|---|
| Which task to do next, and its acceptance tests | `docs/08-implementation-plan.md` |
| What the app must do (FR, BR, NFR, open questions OQ) | `docs/01-prd.md` |
| How sheet columns are filled (DATA_INSPECTION, M100_DEFECT_DETAIL, M100_SUBMISSION, photos, write sequence) | `docs/02-data-design.md` (v1.0) |
| Endpoints, request/response shapes, validation, error codes, outbox behaviour | `docs/04-api-contract.md` + `docs/04-openapi.yaml` (v1.0) |
| How it is built and run: PWA storage, outbox, API modules, Submit PO pipeline, security, deployment | `docs/03-tdd.md` |
| Screens, states, interactions, copy, layouts | `docs/05-ui-ux-spec.md` |
| Why a choice was made (ADR-001 … ADR-017) | `docs/07-decision-log.md` |
| Which docs exist and which are still Planned | `docs/00-document-map.md` |
| Screen layout and interaction flow | `reference/prototype/app.html` (open in a browser). Its **colours and styling are outdated**; take layout and behaviour from it, never its look. |
| Look, tokens, components | `design-system/README.md`, `design-system/tokens.json`, `design-system/components/*/README.md`, reference implementation in `design-system/components/bundle.js` + `bundle.css` |
| Area → sub-area → family → defect mapping | `reference/mapping/mapping.json` (generated from `Footwear_Defect_Mapping_Database_v2.xlsx`) |

Doc 02 (Data Design) and doc 04 (API Contract, v1.1) are final; doc 03 (TDD) is a draft (v0.2) and is the spec for how things are built. Doc 05 (UI/UX spec, draft v0.2) defines every screen S0–S9; where it disagrees with the prototype, doc 05 wins. U2 and U10 in doc 05 §18 are awaiting owner confirmation: implement them as written and do not change them silently (U1 was confirmed on 19 Oct 2026, closing OQ-07). Phase 4 starts with the server pre-checks of doc 03 §7.3. The server is **Windows**, operated by the QIP Digital Team: no bash scripts in `deploy/` or `scripts/` (use Node/TypeScript or PowerShell) and always build paths with `node:path`. HTTPS is decided: `https://m100.qdms.web.id` (ADR-016). If a task depends on something not decided in the docs, stop and say so instead of guessing.

## Stack (ADR-004, ADR-005; React + Vite confirmed)

pnpm workspace monorepo:
- `apps/web`: React 18 + TypeScript + Vite, `vite-plugin-pwa` (Workbox), Zustand (state), Dexie (IndexedDB for sessions, photos, outbox).
- `apps/api`: NestJS + TypeScript, Google Sheets/Drive via a service account, all sheet access behind repository interfaces.
- `packages/shared`: types, the counting engine, mapping loader, number/date formatters. Used by both apps.

Tests: Vitest (unit), Playwright (web end-to-end), Jest (NestJS default). Node 22 LTS.

## Hard rules

1. **Never touch the production spreadsheet.** Development and tests use a copy whose ID comes from `SHEET_ID` in `.env`. Never hard-code a spreadsheet ID, never commit `.env` or any service-account JSON.
2. **Append only (BR-07).** The app never edits or deletes existing rows in any sheet.
3. **One Submit PO = one `values.append` of the `DATA_INSPECTION` row, then one `spreadsheets.batchUpdate`** (format copy, 75 LINK formulas, `M100_DEFECT_DETAIL` rows, `M100_SUBMISSION` row), keyed by a client UUID. Every step is safe to repeat, so a retry never duplicates (doc 02 §8, doc 03 §5.4, ADR-002, ADR-003, BR-06).
4. **Taps never hit the network.** Every tap is saved to IndexedDB before the UI confirms it (NFR-03, NFR-05).
5. **Counting rules (BR-01, ADR-008)** live in one pure function in `packages/shared` with unit tests that reproduce the ADR-008 table exactly:
   - REWORK / B-GRADE / NO DEFECT tap: Qty Inspection +1; NO DEFECT also Qty A-Grade +1.
   - Defect during REWORK: Qty Defect +1. Defect during B-GRADE: Qty Defect +1 and Qty B-Grade +1 (per finding).
   - Defect Rate = Qty Defect ÷ Qty Inspection; Pass Rate (RFT) = Qty A-Grade ÷ Qty Inspection; show "—" when Qty Inspection is 0.
6. **Photos and LINK columns (ADR-011, doc 02 §7):** every DATA_INSPECTION row keeps AppSheet's LINK formula in all 75 LINK cells; never write a plain value there. Photos: PSI lv.2 takes exactly one photo per Top 5 defect, stored in `PHOTO(3n−2)` of the defect's slot n; PSI lv.1 takes no photos at all. `STATUS PO` and `PIC ADM` are always empty (ADR-012).
7. **Defect identity (ADR-009):** use `DEFECT_ID` D001–D098. D049 and D071 share a name; never key anything by defect name alone.
8. **Open questions (PRD §10, OQ-01 … OQ-12):** if a task touches one, stop and ask. Never pick an answer silently.

## UI rules

- Screen text in Bahasa Indonesia. These labels stay English and uppercase: ADD DEFECT, REWORK, B-GRADE, NO DEFECT, END INSPECTION, BACK, HOME, UNDO, SUBMIT PO, LOGIN, EXPORT PDF, EXPORT EXCEL, TOP 5 DEFECT, QTY INSPECTION, DEFECT RATE, PASS RATE (RFT).
- Defect names exactly as in the mapping (case and brackets kept).
- Numbers `id-ID` (2.400; 18,8%), times WIB (Asia/Jakarta).
- No device keyboard except the PO search box; numbers (the PO partial quantity, ADR-013) use the app's own number pad. Every tappable element ≥ 44 × 44 px (`--tap-min`).
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
