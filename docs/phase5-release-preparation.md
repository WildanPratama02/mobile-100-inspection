# Phase 5 release preparation

**Status: HOLD.** Nothing in this document authorizes a release, deployment or merge. A gate is PASS only
when its verification below has been executed and its evidence recorded in `phase5-integration-review.md`.
Prepared 29 Oct 2026 on branch `t5-qty-inspection`. Companion documents:
[`phase5-recovery-runbook.md`](phase5-recovery-runbook.md) (procedures) and
[`phase5-integration-review.md`](phase5-integration-review.md) (evidence).

Decisions marked **OWNER** need the product owner's written approval before release.

**Owner decisions of 29 Oct 2026:**

| # | Decision | Effect here |
|---|---|---|
| D1 | PostgreSQL 18 approved **in principle** as the production major version | ADR-020 written (doc 07); in effect only after its requirements pass. Running production database unchanged |
| D2 | The proposed 24-hour data-loss allowance is **not approved**. Zero loss of server-accepted submissions is the desired objective, **not a proven guarantee** | Section 3 rewritten; recovery options in section 6; final RPO proposal only after the investigations and a rehearsal |
| D3 | RTO **provisional**: 4 hours on the same server, 1 business day on a replacement server, pending a timed rehearsal | Section 3; checklist C6, C10 measure it |
| D4 | Recovery tooling: **design only**, nothing implemented or deployed without approval | Section 7 |
| D5 | Both Phase 5 documents live at `docs/phase5-integration-review.md` and `docs/phase5-release-preparation.md` and are committed to `t5-qty-inspection` (documentation only) | — |

## 1. PostgreSQL production compatibility

### 1.1 Facts (observed read-only on 28–29 Oct 2026; nothing on the installed server was changed)

| Item | Observed |
|---|---|
| Documented target | PostgreSQL 16 (ADR-018, doc 03 §1, §7; `install.ps1` default service `postgresql-x64-16`; `restore.ps1` and the recovery runbook name PostgreSQL 16 tools) |
| Installed server | Service `postgresql-x64-18`, Running, Automatic, account `NT AUTHORITY\NetworkService`, `C:\Program Files\PostgreSQL\18\data`, port 5432, **PostgreSQL 18.1** |
| M100 installation | `D:\Project\M100`, `install.json`: `PostgresService = postgresql-x64-18`, `PostgresBin = C:\Program Files\PostgreSQL\18\bin`, `BackupDir = D:\m100_backup`; release `2026.10.26-ce37679` (before Phase 5, migrations up to 0005); `m100-api` and `m100-caddy` **Stopped** |
| Existing backups | `D:\m100_backup\daily` and `photos` exist; made with `PG_BIN` from `install.json`, i.e. PostgreSQL 18 `pg_dump` |

### 1.2 Evidence from disposable clusters (job temp folder, localhost, never the installed service)

| Run | Result |
|---|---|
| Full API suite on PostgreSQL **16.15** (`e860c14`) | 754 tests: 715 passed, 0 failed, 39 conditional skips |
| Full API suite on PostgreSQL **18.1** (`e860c14`, `PG_BIN` = PG18 tools, cluster made with the installed 18.1 binaries) | 754 tests: 715 passed, 0 failed, the same 39 skips; includes migrations 0001–0006, constraints, immutability trigger, backup and restore tests |
| `pg_dump` 16 against a PG18 server | **Refused**: "aborting because of server version mismatch" |
| `pg_restore` 16 on a `pg_dump` 18 custom archive | **Refused**: "unsupported version (1.16) in file header" |
| `pg_restore` 18 of a PG18 archive into PG16 | **Fails**: `SET transaction_timeout = 0` is unknown to PG16 |
| `psql` 16 loading a `pg_dump` 18 plain dump into PG16 | **Fails** on the same `transaction_timeout` line |

Not yet run on PG18: the tablet/PWA and admin browser suites (they passed on PG16), the T3.7 load test.

### 1.3 Options

| Option | What it means | Risk | Prerequisites |
|---|---|---|---|
| **A. Adopt PostgreSQL 18 as the production target (recommended)** | Keep the installed 18.1 server; Phase 5 runs on it unchanged | Low for the application (full API suite green on 18.1); documentation and tooling still name 16 | **OWNER** approves an ADR amending ADR-018's version; run the browser suites and T3.7 on PG18; switch every restore machine, `restore.ps1`/runbook examples and `install.ps1` default to PostgreSQL 18; restore an actual `D:\m100_backup` dump with PG18 tools on another machine (checklist C6); patch policy for 18.x minor releases |
| B. Move production to PostgreSQL 16 | Install 16 side by side (another port), move the data from 18 | **High**: a downgrade is not a supported PostgreSQL path; the probe shows PG18 dumps fail on PG16 without hand-editing; every existing PG18 backup becomes unreadable for PG16 tools | **OWNER** decision with a stated reason; a reviewed, rehearsed data-move procedure with full row and photo comparison; new baseline backups with PG16 tools; maintenance window |
| C. Keep 18 but use the PostgreSQL 16 tools | — | **Not viable**: `pg_dump` 16 refuses the 18 server, so nightly backups would fail | — |

**Recommendation: A** — **approved in principle by the OWNER on 29 Oct 2026 (D1), recorded as ADR-020**,
because production already runs and backs up on 18.1, the API suite is green on it,
and B is a downgrade with no supported tooling. Whichever option is chosen, server and tools must match
(`PG_BIN` = the server's major version), and restore machines need the same major version.

## 2. Recovery plan for migration 0006

**Application-only rollback to release `2026.10.26-ce37679` (or any pre-Phase 5 release) is unsupported**
once migration 0006 has run, and a schema downgrade is unsupported. Reasons (runbook "Compatibility
boundary"): the old API's INSERT omits `counting_rule`, which has no default after 0006 (SQLSTATE 23502);
the old readiness check expects migration 0005; the old API rejects `counts.qtyInspection`; the old tablet
reducer cannot replay `SET_QTY_INSPECTION`. `upgrade.ps1` from the Phase 5 release refuses automatic fallback
when migration histories differ; an older `upgrade.ps1` lacks that guard and must not be used.

### 2.1 Before the upgrade (mandatory)

1. Announce a window at a shift change; ask PSI to send waiting items first (header counter = 0) but
   **not** to clear site data or reinstall.
2. Run a backup with matching tools: `deploy\windows\m100.ps1 backup --kind pre-upgrade` (`upgrade.ps1`
   takes another one itself). Record the folder, its `manifest.json` and the photo mirror size.
3. Restore that backup on another machine (checklist C6) **before** the production upgrade. A backup that
   has not been restored is not a recovery point.
4. Keep the previous release folder, the backup folder and `D:\m100_backup\photos` read-only for the
   retention period.

### 2.2 Decision tree after a failed or faulty upgrade

| Situation | Action |
|---|---|
| 0006 not applied (migration failed before commit) | Migration history identical: `upgrade.ps1` may fall back automatically; verify readiness (C3) before opening ingestion |
| 0006 applied, new API faulty | **Forward recovery** (runbook §"Preferred response"): keep services stopped, preserve evidence, ship a fixed Phase 5 release that keeps both request formats and migration 0006; never edit applied migrations or recalculate ADR-008 rows |
| 0006 applied, database damaged | Restore the most recent **complete** backup with Phase 5 code into a new database (runbook "Coordinated application/database restore"); keep the damaged database read-only for reconciliation |
| Must return to the pre-Phase 5 release | Only by restoring the pre-0006 backup **together with** the old release and keeping every tablet that ran Phase 5 isolated; every submission accepted after that backup is lost unless reconciled (tool not implemented, see 2.3). Requires **OWNER** approval of the loss |

Ingestion (Caddy) stays stopped until checklist C3 passes on the recovered installation: a wrong-version API
turns waiting outbox items into "Gagal" on `422`, and Gagal items are never resent automatically (AC-11.4).

### 2.3 Known gaps (block release until resolved or accepted by the OWNER)

- The partial-evidence reconciliation tool (runbook) is **not implemented**.
- No feature resends a submission the tablet already marked "Terkirim"; after a server restore, those
  are recoverable only from server evidence or an IndexedDB export of the tablet.
- The upgrade checks liveness (`/v1/health`), not readiness; C3 must be run by hand.

## 3. Recovery objectives (OWNER decisions D2, D3 of 29 Oct 2026)

The earlier proposal of a 24-hour data-loss allowance was **not approved**.

| Objective | Status | Notes |
|---|---|---|
| **RPO, server-accepted submissions: zero loss** | **Desired objective, NOT a proven guarantee** | Today's installation (nightly `pg_dump` at 01:00 + photo copy) can lose up to about 24 h of accepted submissions on a restore. Options that close the gap are in section 6; a final, achievable RPO is proposed only after those investigations and a timed rehearsal |
| **RPO, submissions not yet acknowledged on tablets** | 0 by design, conditional | They stay in IndexedDB until `200`/`201` and resending is idempotent (BR-06); lost if the tablet is cleared, reinstalled or lost |
| **RTO, same server** | **4 hours, provisional** | Pending the timed rehearsal (checklist C6, C10) |
| **RTO, replacement server** | **1 business day, provisional** | Needs the release zip, PostgreSQL 18 (ADR-020), secrets and the backups on another disk/share; pending rehearsal |
| **Outage the tablets absorb** | Not a target; observed behaviour | Inspection continues offline; sealed items wait without a time limit while site data is intact; a PSI token more than 30 days past expiry needs a new login (doc 04 A7); device storage is the practical limit (not measured) |

**Known gaps against the zero-loss objective (as built today):**

1. **Submissions accepted after the last backup** are lost on a restore from that backup. Tablets mark them
   "Terkirim" and keep them (with photos) for **7 days** (`SENT_KEPT_MS`, `apps/web/src/db/repo.ts`), but no
   feature resends them (section 7 designs one).
2. **Display numbers.** `submissions.display_no` is an identity column; a database restored from a dump issues
   values that lost submissions already used, so `M100-000123` printed or exported earlier can later name
   another submission (section 7.3).
3. **Photos.** Photos are written before the database transaction and copied to `BACKUP_DIR\photos` only by
   the nightly backup; a newer database (for example after point-in-time recovery) can reference photos the
   copy does not have (section 6.2, 7.4).
4. **Offline outboxes.** Unaffected by a server restore if ingestion reopens only on a compatible Phase 5 API
   (C3): an older API answers `422`, the item becomes Gagal and is never resent automatically (AC-11.4).
5. **Migration 0006 boundary.** Returning to a pre-Phase 5 release loses all post-backup Phase 5 data unless
   reconciled (section 2.2).

## 4. Windows production acceptance checklist

Run in an **elevated Windows PowerShell 5.1** on the server (staging first, then production), from the
unpacked Phase 5 release. Record for each item: date, operator, command output (or file) and PASS/FAIL in
`phase5-integration-review.md`. Status below is the state on 29 Oct 2026.

Common setup:

```powershell
$ErrorActionPreference = 'Stop'
$Root = 'D:\Project\M100'                     # from the installation; production may differ
$S = Get-Content -LiteralPath (Join-Path $Root 'install.json') -Raw | ConvertFrom-Json
$Pg = $S.PostgresBin; $Svc = $S.PostgresService
```

| # | Gate | Commands | PASS when | Status |
|---|---|---|---|---|
| C0 | PostgreSQL decision applied | `& (Join-Path $Pg 'postgres.exe') --version`; `(Get-Service $Svc).Status`; `& (Join-Path $Pg 'pg_dump.exe') --version` | Server and `pg_dump` are both **18.x** (ADR-020) | NOT EXECUTED (installed server 18.1 observed read-only; ADR-020 approved in principle) |
| C1 | Pre-checks | `powershell -ExecutionPolicy Bypass -File deploy\windows\precheck.ps1 -Root $Root -BackupDir $S.BackupDir` | No FAIL; every MANUAL line confirmed in writing | NOT EXECUTED |
| C2 | Caddy configuration and TLS | `& "$Root\caddy\caddy.exe" list-modules \| Select-String cloudflare`; `& "$Root\caddy\caddy.exe" validate --config "$Root\current\deploy\Caddyfile" --adapter caddyfile --envfile "$Root\.env"`; from a factory-Wi-Fi client: `curl.exe -sSI https://m100.qdms.web.id/v1/health` and open `/admin/` | Module present; validate exits 0; a Let's Encrypt certificate is served without warning; headers match `deploy/security-headers.json` | NOT EXECUTED (validate passed earlier with a dummy token only; live TLS never tested) |
| C3 | API readiness, not only liveness | `curl.exe -s https://m100.qdms.web.id/v1/health`; with a test tablet's key: `curl.exe -s -H "X-Device-Key: <test key>" https://m100.qdms.web.id/v1/system/status`; then one ADR-019 submission from a test tablet and one stored ADR-008 outbox item resent byte-for-byte | Health 200; `/system/status` reports every check OK, migration 0006 and submit enabled; both submissions stored (`counting_rule` ADR-019 and ADR-008) and visible in `/admin/` | NOT EXECUTED |
| C4 | Windows services | `Get-Service m100-api, m100-caddy, $Svc \| Select Name, Status, StartType`; `Get-CimInstance Win32_Service -Filter "Name like 'm100%'" \| Select Name, StartName`; `Restart-Service m100-api`; reboot the host; repeat C3 | Services Automatic; PostgreSQL starts before the API; after `Restart-Service` and after a **reboot**, C3 passes without manual steps; WinSW logs rotate in `$Root\logs` | NOT EXECUTED (services currently Stopped; session was not elevated) |
| C5 | File permissions | `icacls $Root`; `icacls "$Root\secrets"`; `icacls "$Root\.env"`; `icacls $S.BackupDir`; as a non-admin user: `Get-Content "$Root\secrets\jwt.key"` must fail | Only Administrators, SYSTEM and the service accounts as set by `install.ps1` (secrets: Administrators F, SYSTEM F, `NT SERVICE\m100-api` RX); non-admin read refused | NOT EXECUTED (secret ACLs could not be read from a non-elevated session) |
| C6 | Backup and restore | `deploy\windows\m100.ps1 backup`; on **another** Windows machine with the same PostgreSQL major version: `deploy\windows\restore.ps1 -From <backup folder> -PgBin <bin>` (scratch database, dropped unless `-Keep`); also restore one existing `D:\m100_backup\daily` folder; time both | Restore verifies dump SHA-256, row counts and photo files; every photo hash compared; measured duration recorded and **≤ the approved RTO** | NOT EXECUTED on a real backup (only fixture restores in tests) |
| C7 | Scheduled backup and retention | `Get-ScheduledTask -TaskName 'M100 nightly' \| Get-ScheduledTaskInfo`; after one night: newest folder in `$S.BackupDir\daily`, `$Root\logs\nightly-*.log` | Last run result 0; new dated folder with `manifest.json`; log without "nightly failed" | NOT EXECUTED |
| C8 | Physical Redmi Pad 2 | On the target tablet (Chrome, installed PWA): setup link → "Tablet terdaftar"; login; ADD DEFECT, REWORK/B-GRADE with several findings; QTY INSPECTION entry; Wi-Fi off → SUBMIT PO → close app → Wi-Fi on → reopen; camera photo (PSI lv.2); EXPORT PDF/EXCEL; impossible-partial case | Exactly one submission per KIRIM on the server with matching totals and photo hashes; outbox drains; layout 1280 × 800; camera `capture` works (R8); impossible case shows "Defect melebihi jumlah pasang" and seals nothing | NOT EXECUTED (only a Samsung SM-T225 was detected earlier; no completed journey) |
| C9 | T3.7 load and fault test | On staging with PostgreSQL 18, from the repository at the release commit with `apps/api/.env` holding `TEST_ADMIN_DATABASE_URL` of a **disposable** staging cluster (never the production database): `pnpm test:load` (defaults: 50 tablets, five 200 KB photos each, 300 s window; fault: database refuses connections 600 s); keep the JSON report it prints | No lost or duplicated submission; p95 per submission reported and accepted by the OWNER (E4); every item stored exactly once after the outage | NOT EXECUTED | No lost or duplicated submission; p95 per submission reported and accepted by the OWNER; every item stored exactly once after the outage | NOT EXECUTED |
| C10 | Recovery rehearsal | Runbook "Release and rehearsal acceptance criteria" 2–4 on staging: pre-0006 backup restore, forward migration, incident restore, service stop/start and reboot at failure points | All criteria met with measured times; no old writer starts against 0006 | NOT EXECUTED |
| C11 | Optional storage and data checks | S3 suite (only if `PHOTO_STORE=s3`); `import-master.real.db.spec.ts` with `MASTER_DATA_DIR` before importing real master data | Pass, or the OWNER records that they are not needed for release 1 | NOT EXECUTED (disk store configured) |
| C12 | Browser suites on PostgreSQL 18 (ADR-020 requirement 5) | With `TEST_ADMIN_DATABASE_URL` of a disposable PG18 cluster: `pnpm e2e` (from a worktree: `E2E_PORT=5174 E2E_PREVIEW_PORT=4174 E2E_API_PORT=3101`; admin `E2E_API_PORT=3102 E2E_ADMIN_PORT=5176`), no filter, no retries | All tablet/PWA and admin tests pass | NOT EXECUTED on staging (local developer-machine evidence only: 76 + 30 passed on PG18.1, see `phase5-integration-review.md`) |

## 5. Summary of open items

| Needs | Items |
|---|---|
| **OWNER decision** | E1 recovery architecture (section 6.3); E2 approval of the tooling design (section 7) and its retention change; E3 final RPO after the rehearsal; E4 p95 threshold for C9; E5 ADR-020 coming into effect once its requirements pass |
| **Windows server access (elevated)** | C0–C7, C9 (staging), C10; the PITR rehearsal of section 6.4 if E1 chooses it |
| **Physical device** | C8 on a Redmi Pad 2 |
| **Still blocked** | Release, deployment and the implementation PR stay on HOLD until every mandatory gate (C0–C12) has executed evidence and the release is explicitly authorized |

## 6. Achievable recovery options (investigation for D2)

### 6.1 What a backup must cover

A submission is accepted when one database transaction commits (`submissions`, findings, photo rows); its
photos are written to the photo store **before** that transaction (doc 02 §6). Recovering an accepted
submission therefore needs (a) its rows, (b) its photo files with matching SHA-256, (c) a `display_no` that
was never given to another submission. Evidence that can exist after a server failure:

| Source | Holds | Lifetime |
|---|---|---|
| Nightly dump (`BACKUP_DIR\daily`) | All rows up to 01:00 | 14 daily, 12 monthly |
| Photo mirror (`BACKUP_DIR\photos`) | Photo files up to the last nightly copy | Kept |
| WAL archive (option R3, not built) | Every committed transaction up to the last archived segment | Until the next base backup + retention |
| API log (`<Root>\logs`, pino JSON) | One line per submission: UUID, display number, user, PO, result (NFR-10) | 30 days; same disk as the installation |
| Tablet outbox (IndexedDB) | Sealed payload bytes, photos, `displayNo`, `sentAt` of every item | Until sent; **7 days after "Terkirim"** |

### 6.2 Options

| Option | Database RPO | Photos | Effort | Notes |
|---|---|---|---|---|
| R1 Nightly `pg_dump` (as built) | ≤ 24 h | Nightly copy | None | Basis of today's gap |
| R2 Frequent `pg_dump` (e.g. hourly in shifts) | ≤ 1 h | Copy at the same cadence | Low: scheduled task + retention | Dumps grow with data; still loses up to the interval |
| **R3 WAL archiving + weekly base backup (PITR)** | **≈ `archive_timeout`, e.g. ≤ 1 min**, if the archive is on another disk/share | Needs **continuous** photo mirroring (e.g. scheduled `robocopy /MIR` every few minutes, or a second copy written by the API) | Medium: `archive_mode = on`, `archive_command` copying to a protected folder, `pg_basebackup` weekly, restore with `restore_command` + `recovery_target_time`; rehearsal on 18 | PostgreSQL feature, supported on Windows; restores with the same major version (ADR-020) |
| R4 Synchronous standby on a second server | 0 for committed transactions | Photo store must be replicated too | High: second server, replication monitoring, failover runbook | Most infrastructure; only if R3 + tablet reconciliation is judged insufficient |
| **T Tablet reconciliation (section 7)** | Recovers accepted submissions still held by tablets | Photos come with the resent payload | Medium: app + API change | Independent of server backups; bounded by tablet retention (7 days today) and intact tablets |

### 6.3 Recommendation for E1

**R3 + T + the display-number guard (7.3)**: R3 bounds the database loss to about a minute when the archive
survives; T closes that minute and covers a lost archive for every submission still on an intact tablet;
7.3 prevents number reuse whatever the restore point. With these, "zero loss of server-accepted submissions"
becomes achievable **except** when the server, its archive and the tablet copy are lost together, or a
submission is older than the tablet retention. Only a rehearsal (6.4) can turn this into a stated RPO (E3).

### 6.4 Investigation and rehearsal plan (nothing done on production)

1. On a disposable PostgreSQL 18 cluster: enable `archive_mode`, archive to a second folder, take
   `pg_basebackup`, write submissions through the API, destroy the data directory, restore to the latest point
   and to a chosen time; compare every row with the API's responses and logs.
2. Measure the WAL volume per day at the expected load (T3.7 data) to size the archive disk.
3. Photo consistency: restore the database to time *t* with the photo mirror of time *t − x* and list
   `submission_photos` rows without a file (expected: the photo-repair path of 7.4 recovers them from tablets).
4. Repeat on staging Windows with the service account, ACLs and the backup share; time it for D3.

## 7. Recovery tooling design (D4: design only, not implemented)

### 7.1 Detecting post-backup submissions

After any restore, `reconcile:inventory` (a server CLI, read-only on the incident evidence) lists every
submission UUID known to **any** source — API log lines, the photo store (`submissions/<yyyy>/<MM>/<uuid>/`),
the WAL-recovered database, the incident database if readable — and compares it with the recovered database.
Output: UUIDs present, missing, and conflicting (same UUID, different `payload_sha256` or totals). It writes
nothing to the database. Conflicts stop the procedure for a human decision.

### 7.2 Recovery epoch and tablet resend

- The restore procedure records a new **recovery epoch** (a `settings` row, written by the restore CLI, audited);
  `GET /system/status` returns it.
- A tablet that sees a new epoch resends **every outbox item it still holds, including "Terkirim" ones**,
  byte for byte with their photos (the existing sender, oldest first). The API's idempotency does the rest:
  same UUID and hash → `200`, unchanged; missing → `201`, stored again with the original `sealed_at`;
  different hash → `409`, left for an admin. Nothing is resealed or converted between ADR-008 and ADR-019.
- The resend records the tablet's original `displayNo` and `sentAt` in the audit log (`details`), so a
  re-created submission can be traced to the number shown earlier.
- Retention: keep "Terkirim" items for at least the time needed to detect and finish a restore. **Proposal:
  30 days instead of 7** (storage per tablet to be measured; OWNER decision E2).

### 7.3 Preventing reuse of display numbers (and duplicate IDs)

- Submission identity stays the tablet's UUID (primary key) plus `payload_sha256`; a re-created submission
  keeps its UUID, so it can never be stored twice.
- `display_no`: before reopening ingestion after a restore, the restore CLI sets the identity above every
  number ever issued: `max(display_no in the recovered DB, highest number in the API log, highest
  `displayNo` reported by tablets) + a margin (e.g. 1,000)`, via
  `ALTER TABLE submissions ALTER COLUMN display_no RESTART WITH <n>` (DDL by `m100_migrate`; rows stay
  unchanged, so BR-07 holds). A re-created submission therefore gets a **new** number, never one that another
  submission had; the old number is kept in its audit entry and shown in the admin detail.
- Readiness (`/system/status`) reports `RECOVERY_PENDING` and keeps Submit PO disabled until the inventory
  has no unresolved conflict and the identity has been advanced.

### 7.4 Recovering missing photo evidence

- After a restore, a read-only check lists `submission_photos` rows whose file is missing or whose SHA-256
  differs.
- Photo repair on resend: when a resent request repeats a stored submission (`200` path), the API checks its
  stored photo rows; for each missing file it writes the part from the request **only if** the part's SHA-256
  equals the stored `sha256` (never otherwise; the database row is not changed). Today the `200` path does
  not touch photos.
- Photos that no tablet can resend stay listed as missing evidence in the admin detail; they are never
  replaced by other data.

### 7.5 Tests the design needs before approval

Recovery rehearsal with: pre-backup and post-backup ADR-008 and ADR-019 submissions; a tablet with sealed,
"Terkirim" and open work; a lost photo file; a conflicting resend. Expected: every server-accepted submission
present once, original UUIDs and hashes, no reused display number, every photo hash verified, no ADR-008
recalculation, all actions in the audit log.
