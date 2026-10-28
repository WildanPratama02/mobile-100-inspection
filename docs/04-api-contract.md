# Mobile 100% Inspection — API Contract

| | |
|---|---|
| Version | 2.1 — 27 Oct 2026: `counts.qtyInspection` entered by the PSI, `noDefect` only for sessions sealed before the update (ADR-019, §4.1, §4.2, A17). v2.0 — 20 Oct 2026, rewritten for ADR-018 (PostgreSQL and object storage). v1.x (Google Sheets) is superseded |
| Date | 27 Oct 2026 |
| Machine-readable spec | [`04-openapi.yaml`](04-openapi.yaml) (OpenAPI 3.1) |
| Related | [01 PRD](01-prd.md) FR-01, FR-03, FR-11, FR-13, FR-14; [02 Data Design](02-data-design.md); [07 Decision Log](07-decision-log.md) ADR-006, 008, 013, 014, 018, 019 |

This document explains the rules behind the OpenAPI file: who may call what, what the API checks, and how the tablet must react to each answer. Where the two disagree, `04-openapi.yaml` is corrected to match this text. Two audiences use the API: the **tablet app** (§2–§7) and the **admin web app** (§8).

## 1. Conventions

- Base path `/v1`. Breaking changes get `/v2`; additions (new optional fields, new endpoints) stay in `/v1`, and clients ignore fields they don't know.
- JSON in UTF-8. Field names in camelCase. Times are ISO 8601 with `+07:00` (WIB), for example `2026-10-16T14:32:05+07:00`.
- Strings from the master data (names, PO, model, destination) are passed through exactly as stored, including any non-breaking spaces (doc 02 §3.3).
- Every error is `application/problem+json` (RFC 9457) with a stable `code`, a `retryable` flag and a `detail` in Indonesian that the app can show as is (§6).
- Every response carries `X-Request-Id`; the API logs it with the submission UUID (NFR-10).

## 2. Authentication

**Tablets** use two layers, because PSI login has no password (ADR-006):

| Layer | Header | Issued | Purpose |
|---|---|---|---|
| Device key | `X-Device-Key: <key>` | Once per tablet, by QIP Digital with the server command `device:add` (doc 03 §7.5). Stored on the tablet. | Only known tablets reach the API. A lost tablet is cut off by revoking its key. |
| User token | `Authorization: Bearer <JWT>` | `POST /auth/login` | Says which PSI, factory and cell the requests are for. |

- `/health` needs nothing. `/system/status`, `/master-data` and `/auth/login` need only the device key (the login screen must work before anyone is logged in). Everything else for tablets needs both.
- The token lives **30 days** so that the login survives closing the app (AC-01.3). The app calls `POST /auth/refresh` when fewer than 7 days remain. Refresh takes a token of the same, unrevoked device that is still valid or expired less than 30 days ago, and returns a new 30-day token with the same claims; it does not check the master data again (that happens on each submission, §4.2). An older token gets `401 TOKEN_INVALID` and the PSI logs in again (§10 A7). Logout only deletes the token on the tablet; the token itself is not revoked, which is acceptable because it is useless without the device key. Tablets are shared (NFR-01), so the outbox keeps the token of each submission's author until that submission is sent, even after the author logs out and another PSI logs in; it refreshes that token if needed.
- The token's claims: `sub` = username, `lvl` = PSI level, `fac`, `cel`, `dev` = device ID, `aud` = `tablet`. The API takes the user, factory and cell for a submission from the request body and checks they match the token (§4.2 rule 1).

**Admins** (§8) log in with a username and password (`POST /admin/auth/login`). The API sets an `HttpOnly; Secure; SameSite=Strict` cookie holding a JWT with `aud` = `admin`, valid 8 hours. Every state-changing admin request must also carry the header `X-Requested-With: m100-admin`. A tablet token never works on `/admin/*`, and an admin cookie never works on tablet endpoints.

## 3. Endpoints (tablet)

| Method and path | Auth | Purpose | PRD |
|---|---|---|---|
| `GET /health` | — | Liveness | — |
| `GET /system/status` | device | Is Submit PO possible right now? Result of the readiness checks (doc 02 §10) | FR-11 |
| `POST /auth/login` | device | Log in by name, level, factory, cell | FR-01 |
| `POST /auth/refresh` | both | New token | AC-01.3 |
| `GET /master-data` | device | Users, factories/cells, areas, families, defects, area map, with ETag | FR-13 |
| `GET /pos?q=&limit=` | both | PO search, ≥ 3 characters, ≤ 20 results | FR-03 |
| `GET /pos/{po}` | both | One PO | FR-03 |
| `POST /submissions` | both | Submit a sealed session with its photos | FR-11 |

The tablet endpoints change no master data. Administration is a separate set under `/admin` (§8).

### 3.1 `POST /auth/login`

```json
{ "username": "AZIZAH", "level": "PSI lv.2", "factory": "F 3", "cell": "F3-10" }
```

The API checks that an **active** (`username`, `level`) exists in `psi_users` and that an active (`factory`, `cell`) exists in `factories`/`cells`. Failures: `422` with `USER_NOT_FOUND` or `CELL_NOT_FOUND`.

### 3.2 `GET /master-data`

One document with everything the tablet needs offline. The tablet sends `If-None-Match` with the version it holds; `304` means its copy is current. The ETag is the database's `master_version` (doc 02 §3), which changes in the same transaction as any master edit, so tablets pick up an admin's change at their next refresh (at most 30 minutes, AC-13.2). Only active rows are included; `factories` lists only `F <number>` factories. Size today: about 63 KB uncompressed, ~7 KB gzipped.

### 3.3 `GET /pos`

Case-insensitive substring match on `po`, `article` and `model` using the trigram index (doc 02 §3.3); a match must lie inside one of the three, not across them. `q` is trimmed first; shorter than 3 characters (or longer than 40) → `422`. `limit` is 1–20, default 20. Which POs are included (all, or only unfinished) is PRD OQ-06; until it is decided, all active POs are searchable. Dates are returned as `YYYY-MM-DD` (`null` if empty).

**Order (§10 A8).** PSI usually type the last 3 or 4 digits of a PO, so the results are ordered: (1) `po` ends with `q`, (2) `po` contains `q` elsewhere, (3) only `article` or `model` contains `q`; within each group the newest PODD first (no PODD last), then `po`.

`GET /pos/{po}` takes the exact PO number (URL-encoded; leading zeros and prefixes kept) and answers `404 PO_NOT_FOUND` for an unknown or deactivated PO. A database error on either endpoint answers `503 DB_UNAVAILABLE` (doc 03 §5.7).

## 4. Submitting a session

### 4.1 Request

`POST /submissions` as `multipart/form-data`:

- part `submission`: the JSON below, `Content-Type: application/json`;
- one part per photo, named `photo_<DEFECT_ID>`, `Content-Type: image/jpeg`.

```json
{
  "submissionUuid": "0f6b6c1e-6a52-4c9f-9a3e-5d7a2b0c41f2",
  "sealedAt": "2026-10-16T14:32:05+07:00",
  "appVersion": "1.0.0",
  "user": { "username": "AZIZAH", "level": "PSI lv.2" },
  "factory": "F 3",
  "cell": "F3-10",
  "po": "0903359388",
  "partial": { "number": 1, "qty": 1200 },
  "counts": { "rework": 10, "bGrade": 2, "qtyInspection": 30 },
  "findings": [
    { "inspectionType": "REWORK", "areaId": "A03", "subAreaId": "SA03L", "familyId": "F03",
      "defectId": "D035", "qty": 3, "firstRecordedAt": "2026-10-16T13:05:11+07:00" },
    { "inspectionType": "B-GRADE", "areaId": "A11", "subAreaId": "SA11B", "familyId": "F12",
      "defectId": "D082", "qty": 2, "firstRecordedAt": "2026-10-16T13:40:02+07:00" }
  ],
  "photos": [
    { "defectId": "D035", "part": "photo_D035", "sha256": "9f2c…" },
    { "defectId": "D082", "part": "photo_D082", "sha256": "41aa…" }
  ]
}
```

The tablet sends **what happened**, not totals: the Qty Inspection the PSI entered, REWORK and B-GRADE inspections started, and findings per area + sub-area + defect + inspection type. The API computes every other total itself with the ADR-019 rules, so a tablet bug cannot write inconsistent numbers:

| Total | Computed as |
|---|---|
| Qty Inspection | `qtyInspection` (entered by the PSI, FR-15) |
| Qty Defect | sum of all `findings[].qty` (defect findings, not defective pairs) |
| Qty A-Grade | `qtyInspection − Qty Defect` |
| Qty B-Grade | sum of `qty` of findings with `inspectionType` = `B-GRADE` |
| RFT, Defect Rate | doc 02 §6.3 |

The result returns these totals; the tablet compares them with what it showed the PSI and logs any difference.

**Sessions sealed before the ADR-019 update.** A tablet may still hold, in its outbox, a session sealed by an older app version; its bytes never change (§4.3). Such a payload has `counts: { rework, bGrade, noDefect }` and no `qtyInspection`. The API accepts it and computes it with the ADR-008 rules (Qty Inspection = `rework + bGrade + noDefect`, Qty A-Grade = `noDefect`), storing `counting_rule = 'ADR-008'` (doc 02 §4.1). `counts` must have exactly one of `qtyInspection` and `noDefect`. Every app version from the update on sends `qtyInspection` only.

### 4.2 Checks before anything is written

All failures are collected and returned together as one `422 VALIDATION_FAILED` with an `errors` list (path, code, message), unless a more specific code is named. Each entry of `errors` carries its own code; when every failure has the same specific code (for example only Top 5 photos are missing), the answer carries that code (`PHOTO_MISSING`), otherwise `VALIDATION_FAILED`. `PO_NOT_FOUND` is `422` here.

1. `user`, `factory`, `cell` match the token and exist, active, in the master data (`USER_NOT_FOUND`, `CELL_NOT_FOUND`).
2. `po` exists in `pos` (`PO_NOT_FOUND`).
3. `counts` (BR-10), each failure as `errors[].code` `INVALID` on path `counts.qtyInspection` (or `counts`):
   - exactly one of `qtyInspection` and `noDefect` is present ("Qty Inspection wajib diisi.");
   - with `qtyInspection` (ADR-019): a positive integer ("Qty Inspection minimal 1."); ≥ Qty Defect, the sum of `findings[].qty` ("Qty Inspection minimal {n}: jumlah defect yang tercatat."); ≤ `partial.qty` when `partial` is present, otherwise ≤ the PO's `ORDER QTY` ("Qty Inspection maksimal {n} pasang."). When Qty Defect is itself above that maximum, both messages are returned;
   - the API applies these rules itself, from the request and the PO in the database; it never relies on the tablet having checked them. The request carries no totals: the API computes them (§4.1) and the database checks them again in the same transaction (doc 02 §4.1, §6.3);
   - with `noDefect` (ADR-008, §4.1): `rework + bGrade + noDefect` ≥ 1, as before.
4. Each finding: `qty` ≥ 1; `defectId` exists in `defects`; `subAreaId` belongs to `areaId`; if `inspectionType` is `REWORK` then `counts.rework` ≥ 1, and likewise for `B-GRADE`. The defect must be mapped to that sub-area in `area_map`, *or* have been mapped there when the session was recorded: a finding is not rejected because the map changed after the PSI tapped it (a deactivated map row is still accepted; a defect id that no longer exists in `defects` is not).
5. No two findings share (`inspectionType`, `areaId`, `subAreaId`, `defectId`).
6. `partial`, if present: `number` 1–99, `qty` 1 … the PO's `ORDER QTY`.
7. Photos (ADR-011):
   - PSI lv.1: no photo parts and an empty `photos` array, otherwise `PHOTO_NOT_ALLOWED`.
   - PSI lv.2: the API ranks the defects by quantity, then severity, then first recorded (doc 02 §8, `v_defect_totals`); each of the top 5 has exactly one photo, otherwise `PHOTO_MISSING` listing them. A photo may also belong to a defect outside the top 5 (AC-10.4). At most one photo per defect.
   - Every `photos[]` entry has its part and every part has an entry; each part is JPEG, ≤ 1 MB, and its SHA-256 matches.
8. `sealedAt` is not more than 5 minutes in the future (tablet clock check).
9. Whole request ≤ 8 MB (`413 PAYLOAD_TOO_LARGE`).

### 4.3 Idempotency

- The tablet creates `submissionUuid` (UUID v4) when the PSI taps KIRIM and never changes it, however many times it retries.
- The tablet serialises the JSON part once, when it seals the session, stores that exact string, and sends those same bytes on every retry (doc 03 §4.6). The API stores the SHA-256 of the part as received (`submissions.payload_sha256`). A repeated UUID with the same hash returns the stored result with `200`. A repeated UUID with a different hash returns `409 SUBMISSION_UUID_REUSED`, and nothing is written.
- Writing follows doc 02 §6: photos first, then one database transaction. A crash at any point leaves either nothing or a complete submission, so a retry just completes it.

### 4.4 Responses

| Status | When | Body |
|---|---|---|
| `201` | Written by this request | `SubmissionResult`: `status: written`, `displayNo`, `totals` |
| `200` | This UUID was written before | Same as the original `201` |
| `409`, `413`, `422` | The request can never succeed as sent | Problem |
| `429` | Too many requests from this device | Problem + `Retry-After` |
| `503` | `SUBMIT_DISABLED` (a readiness check failed), `DB_UNAVAILABLE` or `PHOTO_STORE_UNAVAILABLE` | Problem + `Retry-After` |

The API answers only when the submission is committed (typically under 2 seconds, up to about 5 seconds for five photos). There is no queue, no `202` and no status endpoint. A tablet whose request timed out simply resends; the answer is `200` if the first attempt got through.

## 5. What the tablet does with each answer (outbox)

The outbox on the tablet (FR-11, AC-11.2 … AC-11.4) follows this table exactly:

| Answer | Outbox state | Next step |
|---|---|---|
| `200`, `201` | Terkirim | Store `displayNo`; remove the photos from the tablet after 7 days |
| `401 TOKEN_EXPIRED` | unchanged | `POST /auth/refresh`, then resend once |
| `401 DEVICE_KEY_INVALID` / `TOKEN_INVALID` | Gagal | Show "Tablet belum terdaftar, hubungi admin" |
| `409`, `413`, `422` | Gagal | Show `detail` and `errors`; keep the item; never resend automatically (AC-11.4) |
| `429`, `503`, `5xx`, no connection, timeout | Menunggu koneksi | Resend after `Retry-After`, or with back-off 5 s, 15 s, 1 min, 5 min, then every 5 min |
| App closed or killed while the item was Mengirim | Menunggu koneksi at next start | Resend the same UUID and bytes; the answer is `200` if the first attempt got through |

The request timeout on the tablet is 60 seconds (weak Wi-Fi, five photos). The tablet never needs to ask whether a submission arrived; resending is always safe.

## 6. Error codes

| Code | HTTP | Retryable | `detail` shown to the PSI (example) |
|---|---|---|---|
| `DEVICE_KEY_INVALID` | 401 | no | Tablet belum terdaftar. Hubungi admin. |
| `TOKEN_INVALID` | 401 | no | Sesi login tidak valid. Silakan login ulang. |
| `TOKEN_EXPIRED` | 401 | after refresh | — (handled silently) |
| `USER_NOT_FOUND` | 422 | no | Nama tidak ada di daftar PSI. |
| `CELL_NOT_FOUND` | 422 | no | Factory/Cell tidak ditemukan. |
| `PO_NOT_FOUND` | 404 / 422 | no | PO tidak ditemukan di master PO. |
| `SUBMISSION_UUID_REUSED` | 409 | no | Data kiriman berbeda dengan kiriman sebelumnya. Hubungi admin. |
| `VALIDATION_FAILED` | 422 | no | Data tidak lengkap: (list) |
| `PHOTO_MISSING` | 422 | no | Foto wajib untuk: (defects) |
| `PHOTO_NOT_ALLOWED` | 422 | no | PSI lv.1 tidak mengirim foto. |
| `PAYLOAD_TOO_LARGE` | 413 | no | Ukuran foto terlalu besar. |
| `RATE_LIMITED` | 429 | yes | — (shown as Menunggu koneksi) |
| `SUBMIT_DISABLED` | 503 | yes | Pengiriman sedang dinonaktifkan: (reason from `/system/status`) |
| `DB_UNAVAILABLE` | 503 | yes | — (shown as Menunggu koneksi) |
| `PHOTO_STORE_UNAVAILABLE` | 503 | yes | — (shown as Menunggu koneksi) |
| `INTERNAL` | 500 | yes | Terjadi kesalahan server. Data tetap tersimpan di tablet. |

Admin-only codes (§8): `ADMIN_AUTH_REQUIRED` 401, `ADMIN_LOGIN_FAILED` 401, `ADMIN_LOCKED` 423, `NOT_FOUND` 404, `CONFLICT` 409 (duplicate natural key), `IMPORT_INVALID` 422 (with a row-level `errors` list).

## 7. Limits

| Limit | Value |
|---|---|
| Request size | 8 MB |
| Photo | JPEG, ≤ 1 MB, ≤ 960 px long edge (AC-10.1) |
| Findings per submission | 2,000 |
| Rate per device | 60 requests / minute |
| Admin login | 5 failures → 10 min lock |
| `GET /pos` results | 20 |

## 8. Admin API

Used only by the admin web app (doc 05 §20), in a desktop browser. Cookie auth as in §2; JSON in and out except the imports (multipart) and the CSV export. Every change writes an `audit_log` row (doc 02 §5.3) with the old and new values of the changed fields, and every master-data change (POs included) bumps `master_version` in the same transaction; a change that changes nothing writes nothing. A duplicate natural key is `409 CONFLICT`. Rows are deactivated, never deleted.

| Method and path | Purpose |
|---|---|
| `POST /admin/auth/login`, `POST /admin/auth/logout`, `GET /admin/me`, `POST /admin/me/password` | Session and own password. 5 failed logins lock the account for 10 minutes; password ≥ 10 characters |
| `GET/POST/PATCH /admin/psi-users` | List, add, rename, change level, deactivate/reactivate (no delete) |
| `GET/POST/PATCH /admin/factories`, `/admin/cells` | Same; `GET /admin/cells?factoryId=` filters by factory |
| `GET /admin/pos?q=`, `POST /admin/pos`, `PATCH /admin/pos/{po}` | Search (inactive included, ≤ 50), add, edit one PO; `finished` is neither set nor imported until OQ-06 |
| `POST /admin/pos/import?dryRun=true\|false` | Upload CSV/XLSX (≤ 20 MB); dry run returns counts and row errors; the real run upserts by `po` and never deletes (§10 A9) |
| `GET /admin/defects`, `GET /admin/area-map`, `PATCH /admin/defects/{id}`, `PATCH /admin/area-map/{id}` | View (`/admin/area-map` returns areas, sub-areas, families and map rows); toggle `active` |
| `POST /admin/area-map/import?dryRun=` | Upload the mapping workbook; same validation as doc 02 §5.1, against the stored defects (§10 A10) |
| `GET /admin/submissions?from=&to=&factory=&cell=&username=&po=&page=` | Paged list, 50 per page, newest sealed first (§10 A12) |
| `GET /admin/submissions/{id}` | Detail with findings, Top 5, photo ids and audit trail (§10 A13) |
| `GET /admin/photos/{id}` | Streams the JPEG after checking the admin session (§10 A13) |
| `GET /admin/submissions/export.csv?…` | The list's filters, one row per submission, with the Top 5 as columns (§10 A14) |
| `GET/POST/PATCH /admin/admins` | List, add, deactivate, reactivate, reset a password (§10 A15) |
| `GET /admin/audit-log?from=&to=&actor=&page=` | Read-only, 50 per page, newest first (§10 A16) |

No admin endpoint changes a submission (AC-14.4): there is no route for it, and the database refuses an UPDATE or DELETE anyway (doc 02 §4.1). Reading a submission, a photo or the export writes no `audit_log` row; the log records changes.

## 9. Not in this API

- Exports of the PSI's own session (FR-12) are made on the tablet.
- Device-key provisioning is in the admin API above and in [03 TDD](03-tdd.md) §7.5.
- Reporting tools read the database views (doc 02 §8), not this API.

## 10. Decisions taken during review

| # | Decision |
|---|---|
| A1 | Every tablet has its own device key in addition to the name login (§2, ADR-014). |
| A2 | Login lasts 30 days, refreshed automatically, until LOGOUT (§2). |
| A3 | (v2.0) `POST /submissions` is synchronous: no `202`, no status endpoint, no server queue (§4.4). |
| A4 | 60 requests per minute per tablet (§7). |
| A5 | (v2.0) A tablet resends after any timeout; `200` means "already written" (§5). |
| A6 | (v2.0) Admins use a separate cookie session with `aud` = `admin` and a password; PSI keep name-only login (§2). |
| A7 | (21 Oct 2026, product owner, T2.5) `POST /auth/refresh` also accepts a token up to 30 days past its expiry, so the outbox's "`TOKEN_EXPIRED` → refresh, resend" (§5) works for a tablet left unused for weeks; refresh does not re-check the PSI or cell (§2). |
| A8 | (21 Oct 2026, product owner, T2.6) `GET /pos` puts POs ending with `q` first, because PSI search by the last 3–4 digits; then other PO matches, then article/model matches, each newest PODD first. `q` is trimmed. `GET /pos/{po}` of a deactivated PO is `404` (§3.3). |
| A9 | (23 Oct 2026, product owner, T3b.2) The admin PO import is strict (AC-14.3): every row the one-time import would skip (empty PO, `ORDER QTY` not a whole number ≥ 1, rows of one PO number that differ) is an error, and so is a non-empty PODD/CRD that is not a date. The dry run answers `200` with the errors and the counts of the valid rows; applying with any error answers `422 IMPORT_INVALID` and writes nothing. `skipped` counts unchanged rows and identical repeats; blank lines are ignored. A workbook is read from its sheet `ALL_PO_MASTER`, else its first sheet. |
| A10 | (23 Oct 2026, product owner, T3b.2) The mapping re-import only upserts: areas, sub-areas, families and map rows stored but missing from the workbook stay as they are and are listed in `warnings`; a single map row is switched off with `PATCH /admin/area-map/{id}`. |
| A11 | (23 Oct 2026, product owner, T3b.2) The admin CRUD uses TypeORM entities over the existing tables (doc 03 §5.1); the two imports keep the batched SQL upserts of the one-time import. |
| A12 | (23 Oct 2026, product owner, T3b.3) Submission list filters: `from` / `to` are inclusive WIB dates on `inspection_date`, each optional (the admin app sends today by default); `factory`, `cell` and `username` match exactly; `po` matches any part of the PO number, ignoring case; an empty value is no filter. Newest `sealed_at` first, then `display_no`; 50 per page; the answer is `{ total, page, pageSize, items }`. A bad date, `to` before `from` or a bad `page` is `422`. |
| A13 | (23 Oct 2026, product owner, T3b.3) The detail adds the PO snapshot, `receivedAt`, `appVersion`, `counts`, the findings in first-tap order (the tablet history) with area, sub-area and family names, the Top 5 computed with the shared ranking (with the photo id of each place), the photo ids, and the audit-log rows about the submission (none are written in release 1). An unknown or malformed id is `404`. `GET /admin/photos/{id}` sends the stored bytes as `image/jpeg` with `Cache-Control: private, no-store`; a photo row without its object is `404` (and logged), a store error `503 PHOTO_STORE_UNAVAILABLE`. |
| A14 | (23 Oct 2026, product owner, T3b.3) The CSV export: UTF-8 with a BOM, `,` between fields, CRLF, RFC 4180 quoting, one header row; the columns of `v_submissions` (`display_no` as `M100-000123`, `sealed_at` in WIB) and `top<n>_defect_id`, `top<n>_defect_name`, `top<n>_qty` for n = 1…5. Raw numbers: no thousands separator, a dot for decimals, `rft` and `defect_rate` as the stored fractions (`0.60000`). Text typed by people that starts with `=`, `+`, `-`, `@`, a tab or CR gets a leading `'` (CSV injection). The column list is in `04-openapi.yaml`. |
| A15 | (23 Oct 2026, product owner, T3b.3) `PATCH /admin/admins/{id}` takes either `{ password }` (a reset, which also clears a lock) or `{ active }`, one change per request. A deactivated admin may be reactivated, audited like any change. Deactivating yourself or the last active admin is `422` with `errors[].code` `SELF` / `LAST_ACTIVE_ADMIN`; a taken username is `409 CONFLICT`; a password under 10 characters `422` (`PASSWORD_TOO_SHORT`). The list never carries a password hash. |
| A16 | (23 Oct 2026, product owner, T3b.3) `GET /admin/audit-log`: `from` / `to` inclusive WIB days of `at`, `actor` exact (`admin:<name>`, `script:<name>`, `system`), newest first, 50 per page, `{ total, page, pageSize, items }`. The admin app renders the summary from `details`. |
| A17 | (27 Oct 2026, product owner, ADR-019; revised 28 Oct 2026) `counts.qtyInspection` replaces `counts.noDefect`: the PSI enters Qty Inspection, the API derives Qty A-Grade as `qtyInspection − Qty Defect` (Qty Defect = sum of the findings' `qty`) and checks BR-10 itself (§4.2 rule 3). `rework` and `bGrade` stay in `counts` for the finding-type check and the admin detail; they are in no formula. A payload with `noDefect` (sealed before the update) is still accepted under ADR-008 and stored with `counting_rule = 'ADR-008'`; this stays in `/v1` because no client needs to change for it. The admin detail's `counts` and the summary carry `countingRule`; `counts.noDefect` is `null` for ADR-019 rows and `counts.qtyInspection` is the stored `qty_inspection`. |
