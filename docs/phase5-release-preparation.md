# Phase 5 release preparation

**Status: HOLD until the fast-track go-live steps G0–G10 (section 8.2) pass.** The OWNER chose the fast track on
29 Oct 2026 (F1) and authorized opening the implementation PR; merging and deploying follow section 8. A step or
gate is PASS only when its verification has been executed and its evidence recorded in
`phase5-integration-review.md`. Since 11 Nov 2026 the go-live release is `2026.11.11-5a374ec` on a server whose `current` is `79a0dd3`
(sections 1.1 and 8); G1 and G2 are done, no other step has been executed.
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
| **F1** | **Fast-track go-live (29 Oct 2026, later the same day).** The company has no NAS and no backup permission on a folder share, so the recovery architecture (section 6) and the recovery tooling (section 7) are **skipped** for release 1; the owner wants production earlier. Backups stay on this server until a **second internal disk** is added; until then there is **no off-machine copy** | Section 8 replaces C0–C12 as the go-live gate set; sections 6 and 7 stay as reference for a later release; D2's zero-loss objective is **not met** at go-live (risks accepted in 8.1) |

## 1. PostgreSQL production compatibility

### 1.1 Facts (observed read-only on 28–29 Oct 2026, updated 11 Nov 2026; nothing on the installed server was changed)

| Item | Observed |
|---|---|
| Documented target | PostgreSQL 16 (ADR-018, doc 03 §1, §7; `install.ps1` default service `postgresql-x64-16`; `restore.ps1` and the recovery runbook name PostgreSQL 16 tools) |
| Installed server | Service `postgresql-x64-18`, Running, Automatic, account `NT AUTHORITY\NetworkService`, `C:\Program Files\PostgreSQL\18\data`, port 5432, **PostgreSQL 18.1** |
| M100 installation | `D:\Project\M100`, `install.json`: `PostgresService = postgresql-x64-18`, `PostgresBin = C:\Program Files\PostgreSQL\18\bin`, `BackupDir = D:\m100_backup`; release `2026.10.26-ce37679` (before Phase 5, migrations up to 0005); `m100-api` and `m100-caddy` **Stopped** |
| Existing backups | `D:\m100_backup\daily` and `photos` exist; made with `PG_BIN` from `install.json`, i.e. PostgreSQL 18 `pg_dump` |
| **Update 11 Nov 2026** (read-only, non-elevated session on the server; the database was not queried) | — |
| Release folders in `D:\Project\M100\releases` (last migration file in each) | `2026.10.26-ce37679` (0005), `2026.10.29-3e57b57-dirty` (0006), `2026.10.29-71b9ff0` (0006), `2026.11.02-9d7bceb` (0007), `2026.11.10-79a0dd3` (0007); `current` → **`2026.11.10-79a0dd3`**. The `ce37679` line above describes 29 Oct and is superseded |
| `install.json` | `PostgresService = postgresql-x64-18`, `PostgresBin = C:\Program Files\PostgreSQL\18\bin`, `BackupDir = D:\m100_backup` (unchanged) |
| Windows services | `postgresql-x64-18` Running, Automatic; `m100-api` and `m100-caddy` **Stopped**, Automatic (`NT SERVICE\m100-api`, `NT SERVICE\m100-caddy`) |
| What serves production | `m100.qdms.web.id` resolves to `192.168.43.175`, this server's Ethernet address. Port 443: `caddy` (pid 6816); `127.0.0.1:3000`: `node` (pid 15216). Both run in session 0, started 6 Nov 2026 14:06, their parent processes are gone, and they are **not** the M100 services; command line and path are not readable without elevation, so their release is unknown. `GET /v1/health` answered `200 {"status":"ok"}` with a valid certificate |
| Scheduled task | No task named like `M100` is visible from the non-elevated session; `install.ps1` registers `M100 nightly` (SYSTEM) |
| Database migration level | **Not read** (the agent does not query the production database, CLAUDE.md hard rule 1); the operator reads it in G0 step 5 |

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

## 8. Fast-track go-live (OWNER decision F1, 29 Oct 2026; corrected to the server state of 11 Nov 2026)

**Server state (section 1.1, 11 Nov 2026).** `current` is `2026.11.10-79a0dd3` (Phases 5–7, migration files
0001–0007), the M100 services are Stopped, and production is answered by a Caddy and a Node process started on
6 Nov outside the services, running code of an unknown release. The database's migration level has not been read.

**Release.** The go-live release is `2026.11.11-5a374ec` (`main` after PR #29 and #30): Phase 8 (tablet only,
ADR-023) plus documentation and test-harness changes. Its migration files are **identical** (names and SHA-256)
to those of `79a0dd3`, so the upgrade adds no migration of its own. Two cases, decided by G0 step 5:

- **Case A — database at 0007** (expected if the 10 Nov upgrade finished): G6 applies no migration; the code
  rollback to `79a0dd3` is allowed (8.3).
- **Case B — database below 0007** (the 10 Nov upgrade did not finish): G6 applies the missing migrations (0006
  and/or 0007), and the one-way constraints of 8.3 apply as for any migration boundary.

G1 and G2 are done (recorded below). Every other G step is **NOT EXECUTED**, and the C0–C12 statuses of section 4
are unchanged.

### 8.1 Risks the OWNER accepts by going live without sections 6 and 7

Observed on 29 Oct 2026: drive C: (PostgreSQL 18 data) and drive D: (`D:\Project\M100`, photos, and
`D:\m100_backup`) are partitions of **one physical SSD** (Samsung MZVLQ512HBLU, disk 0).

| # | Risk | Consequence |
|---|---|---|
| A1 | **Single SSD.** Database, photos and every backup are on the same disk; no off-machine copy until a second internal disk is added | A failure of that SSD loses **all** submissions, photos and backups since installation. Nothing can be restored |
| A2 | Nightly backup only (R1) | A software, operator or database error restored from the nightly backup loses up to about **24 hours** of server-accepted submissions; D2's zero-loss objective is not met |
| A3 | No reconciliation or resend of "Terkirim" items (section 7 not built) | Submissions lost by A2 are recoverable only by hand, and only while the tablets still hold them (7 days) |
| A4 | Display numbers can be reused after a restore from a dump (7.3 not built) | A number printed or exported before the incident can later name another submission |
| A5 | Migrations 0006 and 0007 are one-way (sections 2 and 8.3). In case A they are already applied and this upgrade adds none; in case B G6 applies them | Once applied, no release below the database's level can run; problems are fixed forward, or recovered by the coordinated restore of 8.3 with OWNER approval of the loss |
| A6 | Gates verified only on the developer machine (API, browser, T3.7 on PG18) or deferred (staging, second-machine restore, reboot) | Server-specific problems (ACLs, TLS, service order) can appear first in production |
| A7 | **Tablet app is one-way.** Phases 6–8 move IndexedDB to version 3 and add the events `SET_QTY_INSPECTION`, `SET_REWORK_APPROVED` and `SET_NO_DEFECT` (ADR-021, ADR-022, ADR-023). Rolling the tablet app back from `5a374ec` to `79a0dd3` keeps IndexedDB version 3, but `79a0dd3` does not know `SET_NO_DEFECT` | A build older than Phase 6 can't read the new tables. After a rollback to `79a0dd3`, an open session that used the NO DEFECT dialog shows other totals (ADR-023); sealed items are unaffected |
| A8 | Sessions left open on a tablet across the update | A PSI lv.1 session started on a pre-Phase 5 build replays its old `NO_DEFECT` taps as ignored (ADR-019 decision 9), so its pairs without defect are lost; avoided by G0 step 3 (every open session submitted before the window) |
| A9 | Gallery photos have no date or EXIF check (ADR-023 decision 9) | A PSI could attach an old or unrelated photo; the reviewer sees every photo in `/admin/` |
| A10 | Physical-device evidence: the camera and gallery check (T4.2, T8.5, risk R8) is recorded only on a substitute device, a Samsung SM-T225 with Android 12 (11 Nov 2026, `phase5-integration-review.md`); nothing on a Redmi Pad 2 yet. The OWNER accepted the Samsung result for PR #29 only (11 Nov 2026); the Redmi check stays in G0 | Until G0 step 2 records it, a device-specific photo problem can appear first in production |
| A11 | **Production served by unmanaged processes** (1.1, 11 Nov 2026): Caddy and Node started 6 Nov outside the M100 services, release unknown | No restart after a crash or reboot; tablets may have loaded an unknown tablet build; the two processes hold ports 443 and 3000, so `m100-caddy` and `m100-api` can't start until they are stopped (G6) |

The OWNER accepted A1–A6 with F1 on 29 Oct 2026. **A7–A11 were added on 11 Nov 2026 for the Phases 6–8 scope and the
observed server state, and are not accepted yet** (8.4).

**Mitigation after go-live (OWNER to schedule):** add a second internal disk and set `BACKUP_DIR` to it
(`install.json` `BackupDir`), then copy the existing `D:\m100_backup` there; this removes A1 for new backups.
Sections 6 and 7 remain available for a later release.

### 8.2 Go-live runbook (release `2026.11.11-5a374ec`)

G0 is with the OWNER and the operator; G3–G9 run in an **elevated** Windows PowerShell 5.1 on the server at a shift
change, with the `deploy\windows` scripts of the **new** release (an older `upgrade.ps1` lacks the
migration-history guard). Record each result (date, operator, command output or file, PASS/FAIL) in
`phase5-integration-review.md`. A step is PASS only with recorded evidence. Stop at the first step that is not
true and follow section 8.3; Caddy (ingestion) stays stopped until G7 passes.

```powershell
# The build output lives in a temporary git worktree: copy the zip to a permanent folder first.
$built = 'D:\Project\mobile-100-inspection v0.1\.claude\worktrees\release-5a374ec\release\m100-2026.11.11-5a374ec.zip'
New-Item -ItemType Directory -Force D:\m100_incoming | Out-Null
Copy-Item $built D:\m100_incoming\
$zip = 'D:\m100_incoming\m100-2026.11.11-5a374ec.zip'
(Get-FileHash $zip -Algorithm SHA256).Hash   # must be 2850AACB1B754335FCAEE11EECAD89FBA3B80B90F253F216A78CECACCF86A65F
$new = 'D:\m100_incoming\2026.11.11-5a374ec'   # any empty folder outside D:\Project\M100
Expand-Archive $zip -DestinationPath $new
Set-Location (Join-Path $new 'deploy\windows')
```

| # | Step | Command / action | Must be true before continuing | Status |
|---|---|---|---|---|
| G0 | Preconditions | 1. The OWNER decisions of 8.4 that block go-live are recorded as approved, or their risk is accepted in writing. 2. Redmi Pad 2 evidence for **Ambil Foto** (camera opens, photo stored) and **Pilih dari Galeri** (gallery or files open, photo stored, an unreadable image shows "Foto tidak bisa dibaca. Pilih foto JPG atau PNG.") is recorded with date, operator, Android and Chrome versions (T4.2, T8.5). 3. Every PSI has submitted every open session and every tablet's waiting counter is 0; nobody clears site data or reinstalls the app. 4. The window is announced. 5. **Current state, read-only:** `Get-NetTCPConnection -State Listen -LocalPort 443, 3000 \| Select LocalAddress, LocalPort, OwningProcess`; for each process `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" \| Select ProcessId, CommandLine`; the database level with `MIGRATE_DATABASE_URL`: `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1` | All five recorded; case A or B stated; the release behind the two listeners named | NOT EXECUTED |
| G1 | Merge | PR #29 and the documentation follow-up PR #30 merged into `main` | On the merged code: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (with `TEST_ADMIN_DATABASE_URL`), `pnpm e2e` green, no retries | **DONE 11 Nov 2026**: #29 merged as `356a996` (tree of `8c1ff38`), #30 as `5a374ec` (docs only). Full verification green on `8c1ff38` and on `e980bb2` (same code; one e2e setup failure from the dev server, rerun green). No review approval recorded on GitHub for #29 |
| G2 | New release zip | From a clean checkout of `main` after the merges: `pnpm release` | Name has no `-dirty`; `<sha>` is on `main`; the zip contains migrations 0001–0007 and `deploy\windows`; hash recorded and checked on the server | **DONE 11 Nov 2026**: `m100-2026.11.11-5a374ec.zip`, SHA-256 `2850AACB1B754335FCAEE11EECAD89FBA3B80B90F253F216A78CECACCF86A65F`, built on this server from a clean detached checkout of `5a374ec` (it lives in a temporary git worktree: copy it as in the block above); no `.env`, `secrets\` or key files inside; migration files identical to `79a0dd3`. Check the hash again before G6: `(Get-FileHash $zip -Algorithm SHA256).Hash` |
| G3 | Versions (C0) | `& 'C:\Program Files\PostgreSQL\18\bin\postgres.exe' --version`; `& 'C:\Program Files\PostgreSQL\18\bin\pg_dump.exe' --version`; `(Get-Content D:\Project\M100\install.json -Raw \| ConvertFrom-Json).PostgresBin` | All 18.x; `PostgresBin` is the 18 `bin` folder | NOT EXECUTED |
| G4 | Pre-checks and storage permissions (C1, C5) | From `$new\deploy\windows`: `.\precheck.ps1 -Root D:\Project\M100 -BackupDir D:\m100_backup`; then `icacls D:\Project\M100`; `icacls D:\Project\M100\secrets`; `icacls D:\Project\M100\.env`; `icacls D:\m100_backup`; and the photo folder of `PHOTO_DIR`; as a non-admin user `Get-Content D:\Project\M100\secrets\jwt.key` must fail | precheck: no FAIL (port 443 is reported in use while the unmanaged Caddy runs: record it, it is cleared in G6), every MANUAL line confirmed in writing; ACLs as `install.ps1` sets them (secrets: Administrators F, SYSTEM F, `NT SERVICE\m100-api` RX); the API account can write `PHOTO_DIR`, the nightly task (SYSTEM) can write `D:\m100_backup`; the non-admin read is refused | NOT EXECUTED |
| G5 | Backup **and restore rehearsal** (C6, same server) | After G0 step 3: `D:\Project\M100\current\deploy\windows\m100.ps1 backup --kind pre-upgrade`; then `.\restore.ps1 -From <that backup folder> -PgBin 'C:\Program Files\PostgreSQL\18\bin'` (scratch database `m100_restore_*`, dropped afterwards; **never** `-Full`); time it | Restore verifies the dump SHA-256, row counts and photo files; record the backup folder, its `manifest.json`, the photo mirror size and the restore duration (against the provisional 4 h RTO) | NOT EXECUTED |
| G6 | Stop the unmanaged processes, upgrade | Downtime starts. `Stop-Process -Id <the pids of G0 step 5>` (only after their command lines are recorded); confirm ports 443 and 3000 are free; then `.\upgrade.ps1 -Release $zip` (takes another pre-upgrade backup, applies only the migrations the database lacks — none in case A —, switches `current`, starts the services) | Script ends without error; `current` → `2026.11.11-5a374ec`; read-only `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1` is `0007_rework_approved_photo_rule`. If it stops, keep services stopped and follow 8.3. Never restart the unmanaged 6 Nov processes as a fallback: their release is unknown | NOT EXECUTED |
| G7 | Service readiness (C3) | `curl.exe -s https://m100.qdms.web.id/v1/health`; `curl.exe -s -H "X-Device-Key: <test tablet key>" https://m100.qdms.web.id/v1/system/status` | Health 200; `/system/status`: every readiness check OK, the migration check at **0007**, submit enabled. Liveness alone is not enough | NOT EXECUTED |
| G8 | HTTPS and services (C2, C4 subset) | From a factory-Wi-Fi client: `curl.exe -sSI https://m100.qdms.web.id/v1/health` and open `https://m100.qdms.web.id/admin/`; `Get-Service m100-api, m100-caddy, postgresql-x64-18 \| Select Name, Status, StartType`; `Get-NetTCPConnection -State Listen -LocalPort 443, 3000` now owned by the services' processes; `Restart-Service m100-api`, then G7 again | Valid Let's Encrypt certificate, no browser warning, headers as `deploy/security-headers.json`; services Running and Automatic and they own both ports; G7 passes again after the restart | NOT EXECUTED |
| G9a | Tablet update and PSI lv.1 smoke (C8 subset) | On one real production tablet (existing key or setup link): open the app on Login or Home with no inspection, so the waiting version takes over (doc 03 §4.8); log in as the test PSI lv.1 of 8.4; test PO; INSPECTION → REWORK with one finding → END; QTY INSPECTION with the number pad; REWORK AND APPROVED 1; no NO DEFECT button and no photo control; SUBMIT PO → KIRIM | The Defect screen has no NO DEFECT; one submission in `/admin/` with "Qty Inspection diisi PSI" (`ADR-019`), correct totals, REWORK AND APPROVED 1, no photos, photo rule "—" | NOT EXECUTED |
| G9b | PSI lv.2 smoke (C8 subset) | Same tablet, test PSI lv.2 of 8.4, test PO. Defect screen: NO DEFECT ×3 (row shows 3); tap the NO DEFECT row → S6a, set 120 → "No Defect diubah menjadi 120"; NO DEFECT once (121); UNDO → 120 ("No Defect dibatalkan"); UNDO → 3 ("Perubahan No Defect dibatalkan"); set 10. REWORK with two findings of two different defects → END; B-GRADE with one finding of a third defect → END (three distinct defects, so three photos are required). Home: QTY INSPECTION 12 and not tappable, Qty A-Grade 10, Qty Defect 3, Qty B-Grade 1, INSPECTION REWORK QTY 1; REWORK AND APPROVED 1. Photos: first defect with **Ambil Foto**, second with **Pilih dari Galeri**, third either way; GANTI FOTO once through the gallery. SUBMIT PO → KIRIM | One submission in `/admin/`: "Hitung per tap (NO DEFECT)" with NO DEFECT 10 (`ADR-008`), photo rule **ALL**, three photos that open, Qty Inspection 12, A-Grade 10, Defect 3, B-Grade 1, REWORK AND APPROVED 1 | NOT EXECUTED |
| G9c | Offline and outbox recovery on the real tablet | Wi-Fi off on the tablet; a short PSI lv.2 session with one finding and its photo; SUBMIT PO → "Tersimpan. Menunggu koneksi.", waiting counter 1; close the app completely and reopen it offline: the item is still waiting, the session data intact; Wi-Fi on: the item is sent without any tap. Optional, only inside the window and before PSI start: the same with `m100-caddy` stopped instead of Wi-Fi off, then started | Exactly one new submission on the server for that tablet (no duplicate after reopening and resending); the waiting counter returns to 0; items left in an outbox by an older build (if any) are also stored, with the counting rule of their payload | NOT EXECUTED |
| G10 | Nightly backup (C7) | In the window: `Get-ScheduledTask -TaskName 'M100 nightly' \| Get-ScheduledTaskInfo` (elevated; not visible from a non-elevated session on 11 Nov). If the task is missing, the nightly backup is not running: register it the way `install.ps1` does (SYSTEM, daily at `BackupTime`, runs `m100.ps1 nightly`) before go-live. Next morning: newest folder in `D:\m100_backup\daily` and its `manifest.json`; `D:\Project\M100\logs\nightly-*.log` | The task exists; next morning LastTaskResult 0, a new dated folder whose manifest counts include the smoke submissions, no "nightly failed" in the log | NOT EXECUTED |

Smoke submissions are permanent: submissions are immutable and there is no void (BR-07). Record their display
numbers in `phase5-integration-review.md` so reports can leave them out (8.4, item P5).

Deferred until after go-live (still recommended, not blocking under F1): host reboot test (C4), a full Redmi Pad 2
journey beyond G0 step 2 and G9 (C8), T3.7 on staging (C9), restore on a second machine with PostgreSQL 18 (C6),
S3 and real master-data tests (C11). Also open: `install.ps1` still defaults to `postgresql-x64-16`; an upgrade
reads `install.json` (`postgresql-x64-18`), but a reinstall on a new server must pass `-PostgresService` (ADR-020).

### 8.3 Rollback compatibility and coordinated recovery

What runs together (code of `main` at `5a374ec`; release folders of 1.1):

| Combination | Works? | Why |
|---|---|---|
| `5a374ec` API + database at 0007 | Yes | The target after G6 |
| `5a374ec` ↔ `79a0dd3` (and `9d7bceb`) | Yes, both directions | Identical migration files; `upgrade.ps1 -Rollback` (back to `79a0dd3`, the release current before G6) and the automatic fallback are allowed by `Assert-CodeRollbackCompatible` (`deploy/windows/common.ps1`); tablet caveat A7 |
| `5a374ec` tablet build + `79a0dd3` API | Yes | Phase 8 changes no payload field: PSI lv.2 still sends `counts.noDefect`, `reworkApproved` and `photoRule` as in Phase 7 |
| Releases below the database's level (`ce37679`: 0005; `71b9ff0`, `3e57b57-dirty`: 0006, once the database is at 0007) | **No** | `ce37679`'s INSERT omits `counting_rule` (no default after 0006, SQLSTATE 23502); every API's readiness check compares the applied migration with its own last one (`readiness.service.ts`), so Submit PO answers `503 SUBMIT_DISABLED` |
| Code rollback to a release with other migration files | **Refused** by design | `Assert-CodeRollbackCompatible` requires identical migration histories |
| New API + payloads sealed by a pre-Phase 5 tablet build (ADR-008 `counts.noDefect`, no `photoRule`) | Yes | Accepted and stored with `counting_rule` `ADR-008` and the Top 5 photo rule (doc 04 §4.1); covered by `e2e/legacy-outbox.spec.ts`. A sealed payload with more pairs than the partial quantity or Qty Order is refused (doc 04 A18, accepted risk) |
| Phase 5+ tablet build + `ce37679` API | **No** | `ce37679` rejects `counts.qtyInspection`, `reworkApproved` and `photoRule` with `422`; the item turns Gagal and is never resent automatically (AC-11.4) |
| A tablet still on an older build after G6 (the unmanaged server may have served any of them) | Accepted, counted by its payload | The waiting version takes over only on Login or on Home without an inspection (doc 03 §4.8), so G9a starts there; a pre-Phase 5 build's submissions arrive as `ADR-008` also for PSI lv.1 |

Coordinated recovery constraints:

1. **Case A, G6 or G7 fails:** let the automatic fallback finish, or run `.\upgrade.ps1 -Rollback` (back to
   `79a0dd3`), then G7 on `79a0dd3`. No restore is needed: neither release changes the database. Before tablets
   reload the older build, ask PSI to submit any session in which they used the NO DEFECT dialog (A7).
2. **Forward fix** for everything else (recovery runbook "Preferred response"): keep `m100-caddy` and
   `m100-api` stopped, keep the evidence, ship a fixed release that keeps migrations 0001–0007 unchanged and accepts
   every payload shape above. Never edit an applied migration and never recalculate stored rows.
3. **Case B, upgrade stopped between 0006 and 0007** (0006 committed, 0007 failed): the database is at 0006. No
   release on the server matches it except `71b9ff0` and `3e57b57-dirty`, which are not candidates; the new API
   waits for 0007. Keep services stopped, fix the cause and run the migrations of the new release again
   (`db:migrate` applies only 0007), then G7. Restore is not needed for this case. If 0006 itself failed, the
   database is unchanged at 0005: the same procedure applies; a fallback to `79a0dd3` would start but refuse
   submissions (its readiness check expects 0007).
4. **Database damaged after G6:** restore the most recent complete backup **with the new release** into a new
   database (runbook "Coordinated application/database restore"); keep the damaged database read-only.
5. **Back to a release below the database's level** (for example `ce37679`) only together with a backup taken at
   that level and its photo mirror, with every tablet that ran a newer build kept off the network (A7; their
   new-format items would be refused and turn Gagal). Every submission accepted after that backup is lost unless
   reconciled by hand (no tool, section 2.3). Needs the OWNER's written approval of the loss.
6. Never restart the unmanaged 6 Nov processes (A11) as a recovery step. In every case ingestion (Caddy) opens only
   after G7 passes on the recovered installation.

### 8.4 Product owner decisions

**Pending until explicitly confirmed in writing** (none of these is approved by this document):

| # | Decision | Blocks |
|---|---|---|
| OQ-05 | Do PSI stop entering the same results in AppSheet once PSI Inspection Report is live? (PRD §10) | Pilot T4.4; reports must not add both systems |
| OQ-06 | Which POs Add PO offers: all active POs, or only those not finished (PRD §10) | What PSI see on day one |
| OQ-09 | Who in QIP Digital maintains defects and the area map in the admin app, and how changes are announced to PSI (PRD §10) | Rollout T4.5 |
| E1 | Recovery architecture (section 6.3) | Later release (skipped for release 1 under F1) |
| E2 | Approval of the recovery tooling design (section 7) and its retention change | Later release |
| E3 | Final RPO after a timed rehearsal | — |
| E4 | p95 threshold for the T3.7 load test (C9) | C9 |
| E5 | ADR-020 (PostgreSQL 18) coming into effect once its requirements pass | G3 |
| A7–A11 | Acceptance of the risks added for Phases 6–8 and the observed server state (8.1) | G0 |
| P5 | How smoke-test submissions are identified and left out of reports (no void exists, BR-07) | G9 |
| P6 | Which test PSI lv.1 and lv.2 accounts and which test PO G9 uses (adding them changes production master data) | G9 |

**Approved:**

- 11 Nov 2026: the Samsung SM-T225 photo-path result (`phase5-integration-review.md`) is accepted for PR #29
  (T8.5). Not a go-live approval: G0 step 2 still needs the Redmi Pad 2 check.

**Proposed recommendations (not approved; for the OWNER to accept, change or reject):**

- OQ-05: PSI stop AppSheet entry for a PO's line once the pilot tablets use PSI Inspection Report for it; during
  the pilot both systems run, but only the pilot comparison reads both.
- OQ-06: offer only POs that are not finished, with the admin able to reactivate one.
- OQ-09: one named QIP Digital owner for master data, changes announced in the PSI shift briefing.
- E5: bring ADR-020 into effect after G3 and G5 pass on the server (PostgreSQL 18 server and tools, restore
  rehearsed with the 18 tools).
- P5: use one dedicated test PO for every smoke submission and list its display numbers in
  `phase5-integration-review.md`.
- P6: one test account per level, deactivated (never deleted) after go-live.
