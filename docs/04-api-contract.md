# Mobile 100% Inspection — API Contract

| | |
|---|---|
| Version | 1.1 — v1.0 approved by the product owner, 16 Oct 2026; v1.1 adds two outbox rows (§5, A5–A6) found while writing doc 03 |
| Date | 16 Oct 2026 |
| Machine-readable spec | [`04-openapi.yaml`](04-openapi.yaml) (OpenAPI 3.1, validated) |
| Related | [01 PRD](01-prd.md) FR-01, FR-03, FR-11, FR-13; [02 Data Design](02-data-design.md); [07 Decision Log](07-decision-log.md) ADR-004, 006, 008, 011, 013 |

This document explains the rules behind the OpenAPI file: who may call what, what the API checks, and how the tablet must react to each answer. Where the two disagree, `04-openapi.yaml` is corrected to match this text. The choices confirmed during review are in §9 and ADR-014.

## 1. Conventions

- Base path `/v1`. Breaking changes get `/v2`; additions (new optional fields, new endpoints) stay in `/v1`, and clients ignore fields they don't know.
- JSON in UTF-8. Field names in camelCase. Times are ISO 8601 with `+07:00` (WIB), for example `2026-10-16T14:32:05+07:00`.
- Strings coming from the spreadsheet (names, PO, model, destination) are passed through byte for byte, including non-breaking spaces (doc 02 D12).
- Every error is `application/problem+json` (RFC 9457) with a stable `code`, a `retryable` flag and a `detail` in Indonesian that the app can show as is (§6).
- Every response carries `X-Request-Id`; the API logs it with the submission UUID (NFR-10).

## 2. Authentication

Two layers, because login has no password (ADR-006):

| Layer | Header | Issued | Purpose |
|---|---|---|---|
| Device key | `X-Device-Key: <key>` | Once per tablet, when the app is installed, by whoever maintains the API. Stored on the tablet. | Only known tablets reach the API. A lost tablet is cut off by revoking its key. |
| User token | `Authorization: Bearer <JWT>` | `POST /auth/login` | Says which PSI, factory and cell the requests are for. |

- `/health` needs nothing. `/system/status`, `/master-data` and `/auth/login` need only the device key (the login screen must work before anyone is logged in). Everything else needs both.
- The token lives **30 days** so that the login survives closing the app (AC-01.3). The app calls `POST /auth/refresh` when fewer than 7 days remain. Logout only deletes the token on the tablet; the token itself is not revoked, which is acceptable because it is useless without the device key. Tablets are shared (NFR-01), so the outbox keeps the token of each submission's author until that submission is sent, even after the author logs out and another PSI logs in; it refreshes that token if needed.
- The token's claims: `sub` = username, `lvl` = PSI level, `fac`, `cel`, `dev` = device key ID. The API takes the user, factory and cell for a submission from the request body and checks they match the token (§5.2 rule 1).

## 3. Endpoints

| Method and path | Auth | Purpose | PRD |
|---|---|---|---|
| `GET /health` | — | Liveness | — |
| `GET /system/status` | device | Is Submit PO possible right now? Result of the startup checks (doc 02 §10) | FR-11 |
| `POST /auth/login` | device | Log in by name, level, factory, cell | FR-01 |
| `POST /auth/refresh` | both | New token | AC-01.3 |
| `GET /master-data` | device | Users, factories/cells, areas, families, defects, area map, with ETag | FR-13 |
| `GET /pos?q=&limit=` | both | PO search, ≥ 3 characters, ≤ 20 results | FR-03 |
| `GET /pos/{po}` | both | One PO | FR-03 |
| `POST /submissions` | both | Submit a sealed session with its photos | FR-11 |
| `GET /submissions/{uuid}` | both | Status of a submission | FR-11 |

There is no endpoint that changes or deletes spreadsheet data, and none for administration (ADR-007).

### 3.1 `POST /auth/login`

```json
{ "username": "AZIZAH", "level": "PSI lv.2", "factory": "F 3", "cell": "F3-10" }
```

The API checks that (`username`, `level`) exists in `USER_LIST` with a PSI type and that (`factory`, `cell`) exists in `DB_CELL` with a factory of the form `F <number>`. Failures: `422` with `USER_NOT_FOUND` or `CELL_NOT_FOUND`.

### 3.2 `GET /master-data`

One document with everything the tablet needs offline. The tablet sends `If-None-Match` with the version it holds; `304` means its copy is current. The API rebuilds the document from the sheets at most every 30 minutes, or immediately when it restarts (AC-13.2). `factories` lists only `F <number>` factories (doc 02 §3.2); `map` holds only `ACTIVE` rows of `M100_AREA_MAP`. Size today: about 63 KB uncompressed, ~7 KB gzipped.

### 3.3 `GET /pos`

Case-insensitive substring match on `PO`, `ARTICLE` and `MODEL`, served from the API's cached index of `ALL_PO_MASTER`. `q` shorter than 3 characters → `422`. Which POs are included (all, or only unfinished) is PRD OQ-06; until it's decided, all POs are searchable. Dates are returned as `YYYY-MM-DD` (`null` if the sheet cell is empty or unreadable).

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
  "counts": { "rework": 10, "bGrade": 2, "noDefect": 18 },
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

The tablet sends **what happened**, not totals: inspections started per type, and findings per area + sub-area + defect + inspection type. The API computes every total itself with the ADR-008 rules, so a tablet bug cannot write inconsistent numbers:

| Total | Computed as |
|---|---|
| Qty Inspection | `rework + bGrade + noDefect` |
| Qty A-Grade | `noDefect` |
| Qty Defect | sum of all `findings[].qty` |
| Qty B-Grade | sum of `qty` of findings with `inspectionType` = `B-GRADE` |
| RFT, Defect Rate | doc 02 §5 |

The result returns these totals; the tablet compares them with what it showed the PSI and logs any difference.

### 4.2 Checks before anything is written

All failures are collected and returned together as one `422 VALIDATION_FAILED` with an `errors` list (path, code, message), unless a more specific code is named.

1. `user`, `factory`, `cell` match the token and exist in the master data (`USER_NOT_FOUND`, `CELL_NOT_FOUND`).
2. `po` exists in `ALL_PO_MASTER` (`PO_NOT_FOUND`).
3. `rework + bGrade + noDefect` ≥ 1.
4. Each finding: `qty` ≥ 1; `defectId` exists in `DEFECT_LIST`; `subAreaId` belongs to `areaId`; if `inspectionType` is `REWORK` then `counts.rework` ≥ 1, and likewise for `B-GRADE`. The defect must be mapped to that sub-area in `M100_AREA_MAP`, *or* have been mapped there when the session was recorded: a finding is not rejected because the map changed after the PSI tapped it.
5. No two findings share (`inspectionType`, `areaId`, `subAreaId`, `defectId`).
6. `partial`, if present: `number` 1–99, `qty` 1 … the PO's `ORDER QTY`.
7. Photos (ADR-011):
   - PSI lv.1: no photo parts and an empty `photos` array, otherwise `PHOTO_NOT_ALLOWED`.
   - PSI lv.2: the API ranks the defects as in doc 02 §6.2; each of the top 5 has exactly one photo, otherwise `PHOTO_MISSING` listing them. A photo may also belong to a defect outside the top 5 (AC-10.4). At most one photo per defect.
   - Every `photos[]` entry has its part and every part has an entry; each part is JPEG, ≤ 1 MB, and its SHA-256 matches.
8. `sealedAt` is not more than 5 minutes in the future (tablet clock check).
9. Whole request ≤ 8 MB (`413 PAYLOAD_TOO_LARGE`).

### 4.3 Idempotency

- The tablet creates `submissionUuid` (UUID v4) when the PSI taps KIRIM and never changes it, however many times it retries.
- The tablet serialises the JSON part once, when it seals the session, stores that exact string, and sends those same bytes on every retry (doc 03 §4.6). The API stores the SHA-256 of the part as received with the submission. A repeated UUID with the same hash returns the stored result: `200` if written, `202` if still in progress. A repeated UUID with a different hash returns `409 SUBMISSION_UUID_REUSED`, and nothing is written.
- Writing follows doc 02 §8, whose steps are all safe to repeat; a crash at any point is completed by the next attempt.

### 4.4 Responses

| Status | When | Body |
|---|---|---|
| `201` | Written within this request | `SubmissionResult` with `status: written`, `diId`, `totals` |
| `200` | This UUID was written before | Same as the original `201` |
| `202` | Valid, queued; not finished within **20 s**, e.g. while backing off from Google's rate limit | `status: queued` or `writing` |
| `409`, `413`, `422` | The request can never succeed as sent | Problem |
| `429` | Too many requests from this device | Problem + `Retry-After` |
| `503` | `SUBMIT_DISABLED` (startup checks failed) or `GOOGLE_UNAVAILABLE` | Problem + `Retry-After` |

`GET /submissions/{uuid}` returns the same `SubmissionResult`, with `status: failed` and a `problem` if the write gave up (§5).

## 5. What the tablet does with each answer (outbox)

The outbox on the tablet (FR-11, AC-11.2 … AC-11.4) follows this table exactly:

| Answer | Outbox state | Next step |
|---|---|---|
| `200`, `201` | Terkirim | Store `diId`; remove the photos from the tablet after 7 days |
| `202` | Mengirim | `GET /submissions/{uuid}` after 10 s, then every 30 s, until `written` or `failed` |
| `GET /submissions/{uuid}` → `written` | Terkirim | As for `201` |
| `GET /submissions/{uuid}` → `failed` with `problem.retryable: true` | Menunggu koneksi | Resend the same UUID and bytes with the back-off below |
| `GET /submissions/{uuid}` → `failed` with `problem.retryable: false` | Gagal | As for `409`, `413`, `422` |
| `GET /submissions/{uuid}` → `404 SUBMISSION_NOT_FOUND` while the item is Mengirim | Menunggu koneksi | The API restarted and lost its queue. Resend the same UUID and bytes; the write is idempotent, so if the earlier attempt finished the answer is `200` |
| `401 TOKEN_EXPIRED` | unchanged | `POST /auth/refresh`, then resend once |
| `401 DEVICE_KEY_INVALID` / `TOKEN_INVALID` | Gagal | Show "Tablet belum terdaftar, hubungi admin" |
| `409`, `413`, `422` | Gagal | Show `detail` and `errors`; keep the item; never resend automatically (AC-11.4) |
| `429`, `503`, `5xx`, no connection, timeout | Menunggu koneksi | Resend after `Retry-After`, or with back-off 5 s, 15 s, 1 min, 5 min, then every 5 min |

The API's own retries against Google (429 back-off, NFR-07) happen behind `202`; the tablet never talks to Google.

## 6. Error codes

| Code | HTTP | Retryable | `detail` shown to the PSI (example) |
|---|---|---|---|
| `DEVICE_KEY_INVALID` | 401 | no | Tablet belum terdaftar. Hubungi admin. |
| `TOKEN_INVALID` | 401 | no | Sesi login tidak valid. Silakan login ulang. |
| `TOKEN_EXPIRED` | 401 | after refresh | — (handled silently) |
| `USER_NOT_FOUND` | 422 | no | Nama tidak ada di daftar PSI. |
| `CELL_NOT_FOUND` | 422 | no | Factory/Cell tidak ditemukan. |
| `PO_NOT_FOUND` | 404 / 422 | no | PO tidak ditemukan di master PO. |
| `SUBMISSION_NOT_FOUND` | 404 | no | — |
| `SUBMISSION_UUID_REUSED` | 409 | no | Data kiriman berbeda dengan kiriman sebelumnya. Hubungi admin. |
| `VALIDATION_FAILED` | 422 | no | Data tidak lengkap: (list) |
| `PHOTO_MISSING` | 422 | no | Foto wajib untuk: (defects) |
| `PHOTO_NOT_ALLOWED` | 422 | no | PSI lv.1 tidak mengirim foto. |
| `PAYLOAD_TOO_LARGE` | 413 | no | Ukuran foto terlalu besar. |
| `RATE_LIMITED` | 429 | yes | — (shown as Menunggu koneksi) |
| `SUBMIT_DISABLED` | 503 | yes | Pengiriman sedang dinonaktifkan: (reason from `/system/status`) |
| `GOOGLE_UNAVAILABLE` | 503 | yes | — (shown as Menunggu koneksi) |
| `INTERNAL` | 500 | yes | Terjadi kesalahan server. Data tetap tersimpan di tablet. |

## 7. Limits

| Limit | Value |
|---|---|
| Request size | 8 MB |
| Photo | JPEG, ≤ 1 MB, ≤ 960 px long edge (AC-10.1) |
| Findings per submission | 2,000 |
| Rate per device | 60 requests / minute |
| `GET /pos` results | 20 |

## 8. Not in this API

- Reading results back (dashboards, history of submitted rows): Leader Quality uses the spreadsheet and AppSheet (PRD §4). PRD OQ-08 may add a read endpoint later.
- Exports (FR-12) are made on the tablet from its own data.
- Device-key provisioning is an operational procedure, not an endpoint: [03 TDD](03-tdd.md) §4.9 and §7.5.

## 9. Decisions taken during review (16 Oct 2026)

| # | Decision |
|---|---|
| A1 | Every tablet has its own device key in addition to the name login (§2, ADR-014). |
| A2 | Login lasts 30 days, refreshed automatically, until LOGOUT (§2). |
| A3 | `POST /submissions` answers `202` and continues in the background when writing takes longer than 20 s (§4.4). |
| A4 | 60 requests per minute per tablet (§7). |
| A5 | (v1.1, from doc 03) The API keeps its queue in memory, so a poll that gets `404` means "resend", not "lost" (§5). |
| A6 | (v1.1, from doc 03) A job that gave up with a retryable problem is resent by the tablet; only a non-retryable problem ends as Gagal (§5). |
