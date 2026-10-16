# Mobile 100% Inspection — Decision Log (ADRs)

Each entry records one decision: the situation, what was decided, and what it costs. Statuses: **Accepted** (decided by the product owner), **Proposed** (recommended, waiting for confirmation), **Superseded** (replaced by a later ADR, kept for history).

| ADR | Decision | Status | Date |
|---|---|---|---|
| 001 | The existing "100%INLINE IMPACTIVA" spreadsheet is the database | Accepted | 15 Oct 2026 |
| 002 | Write DATA_INSPECTION in its existing format, plus a new detail sheet | Accepted | 15 Oct 2026 |
| 003 | One Submit PO = one session = one DATA_INSPECTION row | Accepted | 15 Oct 2026 |
| 004 | Backend: NestJS API with the spreadsheet behind a repository layer | Accepted | 15 Oct 2026 |
| 005 | Frontend: Progressive Web App (React + Vite) | Accepted | 15–16 Oct 2026 |
| 006 | Login by choosing the PSI's name; no NIK, no password | Accepted | 15 Oct 2026 |
| 007 | No admin role inside the app | Accepted | 15 Oct 2026 |
| 008 | Inspection counting rules (Rework / B-Grade / No Defect) | Accepted | 15 Oct 2026 |
| 009 | Defect identity and the area mapping database | Accepted | 15 Oct 2026 |
| 010 | Product name: Mobile 100% Inspection | Accepted | 15 Oct 2026 |
| 011 | Photos uploaded to Google Drive; links in LINK1–LINK75 | Accepted | 16 Oct 2026 |
| 012 | `STATUS PO` and `PIC ADM` are left empty | Accepted | 16 Oct 2026 |
| 013 | `PARTIAL OF QTY PO` is captured when the PO is added | Accepted | 16 Oct 2026 |
| 014 | Per-tablet device key plus a 30-day user token | Accepted | 16 Oct 2026 |
| 015 | API hosted on an existing PWI server; HTTPS required | Accepted (HTTPS method: ADR-016) | 16 Oct 2026 |
| 016 | HTTPS through a domain of our own (`qdms.web.id`, Cloudflare DNS, Let's Encrypt via Caddy) | Accepted | 16 Oct 2026 |
| 017 | Server shape: Caddy + NestJS, no database, the tablet is the durable store | **Proposed** | 16 Oct 2026 |

---

## ADR-001 — The existing spreadsheet is the database

**Context.** Inspection data already lives in the Google Sheet "100%INLINE IMPACTIVA", which is the backend of a live AppSheet app (`100PERCENTINLINEIMPACTIVA`). `DATA_INSPECTION` held about 2,340 rows on 15 Oct 2026, growing by roughly 32 rows a day from PSI lv.1, PSI lv.2, T1QM 1–3 and AQL 3rd party. Existing reports and the `SUMMARY` sheet read from it. The master data Mobile 100% Inspection needs is in the same file: `USER_LIST`, `ALL_PO_MASTER`, `DB_CELL`, `DEFECT_LIST`.

**Decision.** Mobile 100% Inspection reads its master data from, and writes its results to, this spreadsheet. No separate database in release 1.

**Consequences.**
- Mobile 100% Inspection results appear next to existing data without a migration or new reports.
- Mobile 100% Inspection shares the file with a live app. Every write must follow AppSheet's row format (ADR-002) and must never edit or delete existing rows.
- The file already uses about 4M of Google Sheets' 10M-cell limit, and every DATA_INSPECTION row costs 276 cells. The app writes one row per Submit PO, never one per tap (ADR-003).
- There are no transactions, foreign keys or unique constraints. The backend enforces them (ADR-004).
- Moving to PostgreSQL later is possible through the repository layer in ADR-004, and would be recorded as a new ADR.

## ADR-002 — Existing DATA_INSPECTION format plus a detail sheet

**Context.** `DATA_INSPECTION` stores one inspection session per row: 18 header columns, 25 defect slots of 10 columns each (`DEFECTn`, `DEFECT NAMEn`, `DEFECT CLASSIFICATION n`, `QTY DEFECT n`, three `PHOTO`/`LINK` pairs), then `A-GRADE`, `B-GRADE`, `C-GRADE`, `TOTAL DEFECT`, `RFT`, `DEFECT RATE`, `STATUS PO`, `PIC ADM`: 276 columns. It has no place for the shoe area, sub-area, defect family or inspection type (Rework / B-Grade), all of which Mobile 100% Inspection captures.

**Options considered.** (a) Write only the existing format; area data is lost. (b) Write only new sheets; existing reports don't see Mobile 100% Inspection data. (c) Both.

**Decision.** (c). On Submit PO the backend writes:
1. one row in `DATA_INSPECTION`, in exactly the format AppSheet writes, so existing reports keep working;
2. one row per *area × sub-area × defect × inspection type* in a new sheet `M100_DEFECT_DETAIL`, keyed to the DATA_INSPECTION row by the same `ID`.

**Consequences.**
- Defects are summed by defect name into the 25 slots. A session with more than 25 distinct defects fills slots 1–25 by quantity and keeps the rest only in the detail sheet; the row is flagged (rule defined in doc 02).
- Each written row must include the per-row `LINK` formulas that AppSheet rows carry; the photos themselves are in Google Drive (ADR-011, doc 02 §7).
- The sheets must stay consistent. Amended 16 Oct 2026: a submission is one `values.append` of the row plus one `batchUpdate` (formats, LINK formulas, detail rows, submission log), both safe to retry (doc 02 §8).
- Exact column mapping is specified in [doc 02 (Data Design)](02-data-design.md).

## ADR-003 — One Submit PO = one session = one row

**Context.** Existing PSI rows each represent one inspector, one PO and one check round, with `QTY INSPECTION` between 28 and 925 pairs. The Mobile 100% Inspection prototype counts pairs one tap at a time.

**Decision.** The tablet keeps the running session for each PO in its own storage. When the PSI taps **SUBMIT PO**, the session is sent once, written as one DATA_INSPECTION row plus its detail rows, and the PO's counters on the tablet reset to zero. Inspecting the same PO again later starts a new session and produces a new row, as PSI rows do today.

**Consequences.**
- Taps, Undo and End Inspection never reach the server, so they cost no API quota and work without Wi-Fi.
- Data reaches the spreadsheet only at Submit PO. A tablet lost or reset before Submit PO loses that session.
- Every Submit PO carries a client-generated UUID so a retried request never creates a second row.

## ADR-004 — Backend: NestJS API, spreadsheet behind a repository layer

**Context.** Five stacks were compared (Apps Script, NestJS, Dart Frog, Firebase + sync, NestJS + PostgreSQL; see the "M100 Backend Options" artifact). The QIP Digital Team already builds QUDERA, Quality E2E and QCS on NestJS.

**Decision.** A NestJS API sits between the tablets and Google. It authenticates to Sheets and Drive with a service account. All spreadsheet access goes through repository interfaces, so storage can later move to PostgreSQL/Prisma without changing the API or the app.

**Consequences.**
- Google credentials never reach the tablets. Each tablet gets its own token from the API.
- The service account is one Sheets API user: 60 requests per minute (300 per project). Each Submit PO is two write requests (an append, then one `spreadsheets.batchUpdate`; amended 16 Oct 2026, ADR-002, doc 02 §8), and writes to DATA_INSPECTION go through a single-writer queue.
- A service account has no Drive storage of its own, so photo uploads use a separate OAuth user credential (ADR-011, doc 02 §7).
- Master data (users, cells, defects, PO index) is cached by the API and refreshed on a timer; tablets never read `ALL_PO_MASTER` directly.
- Hosting: decided 16 Oct 2026, an existing PWI server (ADR-015); shape in ADR-017.

## ADR-005 — Frontend: Progressive Web App

**Context.** The app runs on shop-floor devices in landscape, input is tap-only, and Wi-Fi may be weak. The team's web stack is React-based (Next.js, Zustand, Dexie in QUDERA).

**Decision.** Mobile 100% Inspection is an installable PWA. Framework confirmed by the product owner on 16 Oct 2026; the libraries are the proposal for doc 03: **React + TypeScript + Vite** with `vite-plugin-pwa` (Workbox) for the service worker, **Zustand** for state, **Dexie** (IndexedDB) for sessions and the outbox, and a camera file input for photos.

**Consequences.**
- One codebase, installed from a URL; updates ship without an app store.
- Sessions survive a reload or app restart because they live in IndexedDB, not memory.
- Camera access uses the browser's file input with `capture`, which opens the device camera on Android tablets.
- iOS limits PWA storage and background sync; release 1 targets Android tablets with Chrome. The device model is an open item.
- Why Vite over Next.js: the app is a static, offline-first client with no server rendering, so Next.js adds weight without benefit. Confirmed: React + Vite (16 Oct 2026).

## ADR-006 — Login by name, no NIK, no password

**Context.** `USER_LIST` has `ID`, `USERNAME` and `TYPE INSPECTION` only. There is no NIK column and no password.

**Decision.** At login the PSI picks their name from the users whose `TYPE INSPECTION` is `PSI lv.1` or `PSI lv.2`, then picks Factory and Cell from `DB_CELL`. Duplicate names with the same type are shown once.

**Consequences.**
- No new user data is needed and nothing is typed.
- **Known risk:** anyone holding a tablet can log in as any PSI. Results carry the chosen name, not a verified identity. Acceptable for release 1 by product-owner decision; options for later are a PIN per user or device-to-user assignment.
- `USER_LIST` contains the same name under different types (for example a name listed as both `CFA` and `PSI lv.1`). Only the PSI types are offered, so each name appears once with its PSI level.

## ADR-007 — No admin role inside the app

**Decision.** Release 1 has two roles, PSI lv.1 and PSI lv.2. Administration (users, cells, defect list, POs, correcting submitted data) is done directly in the spreadsheet by whoever maintains it today.

**Consequences.**
- There are no admin screens, user management or edit/delete of submitted rows in the app.
- A wrong submission is corrected in the spreadsheet, in both `DATA_INSPECTION` and `M100_DEFECT_DETAIL`.

## ADR-008 — Inspection counting rules

**Decision.** Confirmed by the product owner on 15 Oct 2026:

| Event | Qty Inspection | Qty A-Grade | Qty Defect | Qty B-Grade |
|---|---|---|---|---|
| Tap REWORK (start) | +1 | | | |
| Tap B-GRADE (start) | +1 | | | |
| Tap NO DEFECT | +1 | +1 | | |
| Each defect tapped during a Rework inspection | | | +1 | |
| Each defect tapped during a B-Grade inspection | | | +1 | +1 |

Defect Rate = Qty Defect ÷ Qty Inspection. Pass Rate (RFT) = Qty A-Grade ÷ Qty Inspection.

**Consequences.**
- B-Grade is counted **per defect finding**, so one B-Grade pair with two defects adds 2 to Qty B-Grade. Qty A-Grade + Qty B-Grade can therefore exceed Qty Inspection.
- Existing PSI rows in DATA_INSPECTION were entered with A-Grade = Qty Inspection − Total Defect. Mobile 100% Inspection rows count A-Grade directly. The formulas for RFT and Defect Rate are the same, but reports mixing both sources should label the source (the detail sheet and `INSPECTION BY` value make this possible; defined in doc 02).

## ADR-009 — Defect identity and the area mapping database

**Context.** `DEFECT_LIST` holds 98 defects, row for row the same as the mapping database built by the QIP team. Its `CTQ DEFECT CODE` is not unique (52.2 is used three times; X-RAY is `0,01`). One name appears twice: "POOR TOUCH UP/PAINTING, MARKING LINE" (D049 upper, D071 bottom). DATA_INSPECTION stores defects by name only.

**Decision.**
- Mobile 100% Inspection identifies defects by `DEFECT_ID` D001–D098 from the mapping database (`Footwear_Defect_Mapping_Database_v2.xlsx`), whose order matches `DEFECT_LIST`.
- `DATA_INSPECTION` receives the defect name and classification, as today. `M100_DEFECT_DETAIL` also stores `DEFECT_ID`, so D049 and D071 stay distinguishable.
- The mapping is loaded into a new sheet `M100_AREA_MAP` so it can be maintained in the spreadsheet (ADR-007).
- Mapping corrections already applied in v2: Medial Quarter mirrors Lateral Quarter (35 rows added, confirmed); `MAP-098-01` (X-RAY under Inside) moved from sub-area SA12X to SA08L. Heel Counter / Back Tab keeps its 3 defects as in the database (confirmed).

**Consequences.**
- If `DEFECT_LIST` changes order or gains rows, `M100_AREA_MAP` must be updated in the same edit. Doc 02 defines the validation the API runs at startup.

## ADR-010 — Product name: Mobile 100% Inspection

**Decision.** The product is named **Mobile 100% Inspection**, replacing the working name "Mobile PQI for CFA" (product owner, 15 Oct 2026).

**Consequences.**
- On screen the name is set as "MOBILE 100% INSPECTION" (login screen, PDF export header).
- Code identifier: `M100`. The design system's component namespace is `window.M100`, its CSS classes use the `m100-` prefix.
- New spreadsheet sheets use the same prefix: `M100_DEFECT_DETAIL` and `M100_AREA_MAP` (they were planned as `PQI_…`; nothing had been created yet).
- Export file names follow `M100_<PO>_<YYYYMMDD>.pdf` / `.xlsx`.
- Earlier artifacts keep their links; their titles and texts were updated to the new name.

## ADR-011 — Photos go to Google Drive; links in LINK1–LINK75

**Context.** OQ-01. Each of the 25 defect slots in `DATA_INSPECTION` has three photo pairs, so the row has 75 `LINK` columns (`LINK1` … `LINK75`).

**Decision** (product owner, 16 Oct 2026). Mobile 100% Inspection photos are uploaded to Google Drive, and each photo's link appears in the `LINK` column of the slot its defect occupies: photo *k* (1–3) of the defect in slot *n* (1–25) goes to `PHOTO(3(n−1)+k)` / `LINK(3(n−1)+k)`. Columns of photos that don't exist stay empty.

**Mechanism** (proposed after the sheet analysis, doc 02 §7; accepted by the product owner on 16 Oct 2026). Every existing row carries the same AppSheet formula in all 75 LINK cells, and AppSheet only keeps adding it to new rows while the column is consistent. So Mobile 100% Inspection does not write a bare URL into LINK. It uploads the photo into AppSheet's own Drive folder `DATA_INSPECTION_Images` as `<ID>.PHOTO<k>.<HHmmss>.jpg`, writes that path into `PHOTOk`, and writes the same LINK formula as every other row, which turns the path into the link. Alternative if a `drive.google.com` link is required: change the LINK formula in all ~178,000 existing cells to pass full URLs through, a one-time edit of live data.

**Photo rule** (product owner, 16 Oct 2026). PSI lv.2 attaches exactly one photo to each Top 5 defect; it goes to the first photo pair of the defect's slot. PSI lv.1 attaches no photos. So a Mobile 100% Inspection row fills at most `PHOTO1`, `PHOTO4`, `PHOTO7`, `PHOTO10`, `PHOTO13` (plus the first pair of a later slot for a photographed defect that dropped out of the Top 5), and a PSI lv.1 row fills none.

**Consequences.**
- AppSheet shows Mobile 100% Inspection photos, and `SUMMARY` gets the links as before.
- The spreadsheet's owner is a personal Google account, so there is no Shared Drive or domain-wide delegation, and a service account can't own files in that Drive. Photos are uploaded with the OAuth credentials of the sheet owner, `fnd.ahmad12@gmail.com` (decided 16 Oct 2026; doc 02 §7). Its refresh token is a server secret. Sheets access stays with the service account.
- Photos are uploaded before the row is written. File names derive from the submission, so a retry finds files already uploaded and never duplicates them.
- A defect beyond slot 25 (detail sheet only) is moved ahead so that no photographed defect overflows (doc 02 §6.3).
- ADR-002 amended: Mobile 100% Inspection rows carry the LINK formulas like AppSheet rows; the submission takes two Sheets requests instead of one (doc 02 §8).

## ADR-012 — `STATUS PO` and `PIC ADM` are left empty

**Decision** (product owner, 16 Oct 2026). Mobile 100% Inspection writes nothing into `STATUS PO` and `PIC ADM`. They stay empty for whoever fills them today, in the spreadsheet or AppSheet.

**Consequences.**
- The app never reads or shows these columns.
- Also decided on 16 Oct 2026: `INSPECTION BY`, `CFA NAME`, `HISTORYCAL PO` and `C-GRADE` stay empty and `CATEGORY` is always `SHOES` (doc 02 §5). `PARTIAL OF QTY PO`: ADR-013.

## ADR-013 — `PARTIAL OF QTY PO` is captured when the PO is added

**Context.** OQ-02. In existing rows `PARTIAL OF QTY PO` is free text typed in AppSheet, empty in 412 of 600 PSI rows and otherwise written in many styles (`1`, `1200`, `P1 1200`, `1.200 off 10.002`, `Partial 2 1.200 of 6.800`). The meaning is consistent: which partial delivery of the PO (P1, P2…), how many pairs, out of the order quantity.

**Decision** (product owner, 16 Oct 2026). The Add PO dialog gets a **PO PARTIAL** checkbox. When ticked, the PSI enters the partial for that PO, and every Submit PO for the PO writes it to `PARTIAL OF QTY PO`; unticked leaves the column empty.

**Implementation** (accepted 16 Oct 2026, doc 02 §12 Q7). Two structured inputs instead of free text, to keep the app keyboard-free: the partial number with − / + (P1, P2, …) and the partial quantity with an in-app number pad (1 to Qty Order). The API writes them as `P<n> <qty> OF <QTY ORDER>` with Indonesian number format (`P1 1.200 OF 10.002`), and also stores the two numbers in `M100_SUBMISSION`.

**Consequences.**
- FR-03 gains steps 4–6 and AC-03.6 / AC-03.7; NFR-02 allows the in-app number pad.
- The design system needs two more components: a checkbox row and a number pad (doc 06 follow-up).
- The value belongs to the PO entry on the tablet and can be changed with UBAH PARTIAL before any Submit PO.

## ADR-014 — Per-tablet device key plus a 30-day user token

**Context.** Login is by name only (ADR-006), so the login itself proves nothing. If the API were reachable without any other check, anyone who learned its URL could submit inspection data under any PSI's name.

**Decision** (product owner, 16 Oct 2026; details in doc 04 §2).
- Every tablet gets its own device key when the app is installed, sent as `X-Device-Key` on every call. Keys are kept on the API side as a list that can be revoked one by one.
- `POST /auth/login` returns a JWT that lives 30 days and is refreshed automatically when fewer than 7 days remain, so a PSI stays logged in until LOGOUT (AC-01.3).

**Consequences.**
- A lost or retired tablet is cut off by revoking its key; no PSI needs a new login elsewhere.
- Installing a tablet needs one extra step: entering or scanning its key (procedure in doc 03).
- Name-only login remains a known risk *between* PSI on registered tablets (ADR-006); the device key limits it to the factory's own devices.
- Also fixed on 16 Oct 2026: `POST /submissions` answers `202` after 20 s and finishes in the background; 60 requests per minute per tablet (doc 04 §4.4, §7).

## ADR-015 — API hosted on an existing PWI server; HTTPS required

**Context.** OQ-03. PWI has a server the tablets can reach over the factory Wi-Fi. It has no HTTPS today.

**Decision** (product owner, 16 Oct 2026). The NestJS API, and the PWA's static files, run on that PWI server, not on Cloud Run.

**Consequences.**
- **HTTPS is mandatory before the pilot.** Browsers only run service workers in a secure context (HTTPS, or `localhost` during development). Without a service worker the app can't be installed as a PWA and can't open or work offline (NFR-04, ADR-005). Serving the app over plain HTTP from the factory network would also send the device key and tokens (ADR-014) in clear text. How the server gets a certificate trusted by the tablets is open; options in doc 03.
- The server must reach `sheets.googleapis.com`, `www.googleapis.com` (Drive) and `oauth2.googleapis.com` over the internet; the tablets only ever talk to the PWI server.
- Running, backing up and patching the server, and keeping the secrets (service account, Drive OAuth token, device keys) on it, is PWI IT's responsibility; doc 03 lists what is needed.
- Development is unaffected: `http://localhost` counts as secure, so Phase 0–2 can start now.

## ADR-016 — HTTPS through a domain of our own

**Status: Accepted** (product owner, 16 Oct 2026): option 1 below, with the domain `qdms.web.id` that the product owner owns, DNS on Cloudflare, app at `https://m100.qdms.web.id`. The sub-domain name is confirmed before the pilot. Setup: doc 03 §7.2.1.

**Context.** ADR-015 requires HTTPS. On 16 Oct 2026 the product owner reported that PWI has no domain of its own and that the PWI server can reach the internet (Google APIs). Browsers will only run the service worker over HTTPS with a certificate the tablet trusts. Options and their costs are in doc 03 §7.2.

**Options considered.**
1. **Chosen: a domain of our own** (any `.id` or `.com`, in the company's name, roughly Rp 200–300 thousand a year) with a DNS provider that has an API. `m100.<domain>` points to the server's LAN IP and Caddy obtains a free Let's Encrypt certificate with the DNS challenge and renews it by itself. No setup on the tablets.
2. **Fallback: internal certificate authority.** Caddy or `step-ca` issues the certificate; its root certificate is installed once on every tablet; the app is opened by a fixed IP. Free and independent of the internet, but manual per tablet.
3. Not suitable: Cloudflare Tunnel (also needs a domain), the Chrome insecure-origin flag (test only).

**Consequences.**
- The address chosen is the app's *origin*. Changing the host name, or the IP in the fallback, gives tablets an empty local database and loses unsent sessions. It is decided once, before the pilot.
- The application code does not depend on the option; only the Caddyfile and the one-time setup differ.
- Option 1 adds the yearly domain renewal (a lapse stops the name and the certificate renewal) and a Cloudflare API token to the secrets; option 2 would have added a CA private key and a step per tablet.
- Moving the name servers of `qdms.web.id` to Cloudflare moves all of its DNS; anything already using the domain must be recreated first (doc 03 §7.2.1).

## ADR-017 — Server shape: Caddy and NestJS, no database

**Status: Proposed** (design in doc 03; reversible).

**Decision.** On the PWI server (Windows, operated by the QIP Digital Team; answers of 16 Oct 2026) run two processes as Windows services wrapped with WinSW, installed by PowerShell scripts: **Caddy** (HTTPS, static files of the PWA, forwarding `/v1/*`) and the **NestJS API**. The API has no database: its only durable local state is `secrets/` (including the hashed device keys). Its job queue is in memory. The **tablet is the durable store** of a sealed session until the API confirms it, and every write to Google is idempotent, so a lost queue (restart, upgrade) is repaired by the tablet resending.

**Consequences.**
- Fewer parts for PWI IT to run and back up; nothing to migrate.
- A restart during a write is safe but visible: the tablet polls, gets `404`, resends (doc 04 §5, added in v1.1).
- One server, no standby: during an outage submissions wait on the tablets (doc 03 R10).
- Docker is not used on the reference server (Windows); Docker Compose remains possible elsewhere (doc 03 §7.3, T2). Design target: 50 tablets (more than 30 are planned).
- A real database becomes necessary only if a read endpoint (OQ-08) or history needs it; the repository layer (ADR-004) allows it later.
