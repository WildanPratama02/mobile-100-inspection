# Phase 5 integration review — remediation

**Verdict: HOLD until the fast-track go-live steps G1–G9 pass** (`phase5-release-preparation.md` §8).
On 29 Oct 2026 the owner chose the fast track (F1: no NAS or share, so the recovery architecture and tooling are
skipped for release 1, risks A1–A6 accepted) and authorized opening the implementation PR. Merge and deployment
follow §8; nothing here is deployed yet.
Updated 2026-10-28. PASS applies only to the stated executed check, not to a broader
production environment or recovery lifecycle.

## Owner decisions and PostgreSQL 18 verification (2026-10-29, code at `e860c14`)

Owner decisions of 29 Oct 2026 (details in `phase5-release-preparation.md`): PostgreSQL 18 approved in
principle (ADR-020, doc 07; not in effect until its requirements pass); the 24-hour data-loss allowance is
**not approved**, zero loss of server-accepted submissions is the desired objective, **not a proven
guarantee**; RTO 4 h same server / 1 business day replacement server, **provisional**; recovery tooling is
**design only** (section 7 of the preparation document). The running production database was not changed.

Local developer machine, disposable PostgreSQL **18.1** cluster (job temp folder, port 55419, localhost, SCRAM,
created with the installed 18.1 binaries; the installed `postgresql-x64-18` service was not touched):

| Suite | Result |
|---|---|
| API unit + integration (from the previous round, same code) | 754 tests: 715 passed, 0 failed, 39 conditional skips |
| Tablet/PWA E2E, all projects, no filter, no retries | **76 passed** (4.1 min) |
| Admin E2E, no filter, no retries | **30 passed** (46.7 s) |
| T3.7 load and fault test (`pnpm test:load`, defaults: 50 tablets, five 200 KB photos each) | **3 tests passed** (exactly-once asserted). Burst: 50 sent, 0 failed, per submission p50 1,350 ms / p95 1,451 ms / max 1,475 ms. Spread over 300 s: 50 sent, 0 failed, p50 77 ms / p95 145 ms / max 313 ms. Fault (database refusing connections 600 s, 39 requests in flight at stop): 100 sent, 0 failed, submit re-enabled 29.4 s after restart, last stored 59.1 s after restart; time to stored p95 637 s (dominated by the outage); write request p95 787 ms |

These are developer-machine results. They satisfy no Windows-server gate: C0–C11 remain **NOT EXECUTED**;
C12 (browser suites on PG18) has local evidence only and must be repeated on staging before release.

## Release preparation round (2026-10-28/29, `e860c14`)

Revision `e860c14` ("Tamper token signatures deterministically"), 9 commits ahead of
`origin/t5-qty-inspection`, not pushed, not merged, no PR. Plans, options, RTO/RPO proposal and the
executable acceptance checklist are in [`phase5-release-preparation.md`](phase5-release-preparation.md).

**Flaky authentication test fixed (test-only change).** `admin-auth.db.spec.ts` and `tablet-token.spec.ts`
tampered a token by replacing its last two signature characters; that is ignored by base64url decoding about
1 run in 900. New helper `src/testing/tamper.ts` changes one middle character; its spec checks 5,000 random
signatures. `src/auth/jwt.ts` and all production code are unchanged. Affected specs: 38 passed.

| Run (disposable clusters in the job temp folder, localhost, SCRAM, random password) | Result |
|---|---|
| Full API suite on PostgreSQL 16.15 (port 55418) after the fix | 754 tests: 715 passed, **0 failed**, 39 conditional skips; 77 s |
| Full API suite on PostgreSQL **18.1** (port 55419, cluster created with the installed 18.1 binaries, `PG_BIN` = PG18) | 754 tests: 715 passed, **0 failed**, the same 39 skips |
| `pg_dump` 16 → PG18 server | Refused: server version mismatch |
| `pg_restore` 16 on a PG18 custom archive | Refused: unsupported version (1.16) in file header |
| PG18 dump (custom via `pg_restore` 18, or plain via `psql` 16) into PG16 | Fails: `SET transaction_timeout` unknown to PG16 |

The installed `postgresql-x64-18` service, its data directory and `D:\Project\M100` were only read
(service list, `install.json`, folder names); nothing was changed. Both disposable clusters were stopped
afterwards. Browser suites were not rerun in this round (test-only change; last run 76 + 30 passed at
`128d7f2`).

**Release blockers (all gates NOT EXECUTED unless stated):**

| Blocker | Needs |
|---|---|
| PostgreSQL target: docs say 16, production runs 18.1; dumps do not move from 18 to 16 | OWNER decision (recommended: adopt 18 by ADR), then browser suites and T3.7 on 18 |
| RTO/RPO unset | OWNER approval of the proposal and its consequences (post-backup submissions, display numbers, photos) |
| Reconciliation tool and resend of "Terkirim" items not implemented | OWNER: build, or accept the loss window |
| Readiness before reopening ingestion is manual | Server: checklist C3 |
| Caddy live TLS, services, reboot, ACLs | Server (elevated): C2, C4, C5 |
| Real backup restored on another machine; nightly task | Server: C6, C7 |
| Physical Redmi Pad 2 journey | Device: C8 |
| T3.7 load and fault test | Staging server: C9 |
| Recovery rehearsal across migration 0006 | Staging server: C10 |

## Regression run after the validation-priority fix (2026-10-28, `128d7f2`)

Revision `128d7f2` ("Report IMPOSSIBLE before EMPTY in checkSubmit") on `t5-qty-inspection`,
8 commits ahead of `origin/t5-qty-inspection`, not pushed, not merged, no PR.

**Environment.** Windows 11 Pro 10.0.26200, Node 22.17.0, pnpm 10.33.0, Playwright 1.64.1 (Chromium).
Database tests used a disposable PostgreSQL 16.15 cluster created for this run with `initdb` from
`test-results/phase5-remediation/pgsql/bin`: data directory in the job's temporary folder, port 55418,
`listen_addresses = localhost`, SCRAM authentication, a new random superuser password. Before the run it
held only `postgres`, `template0` and `template1`; there is no `m100` database on it, and the test helpers
create and drop only `m100_test_*` databases on it. `apps/api/.env` of this worktree (gitignored) contains
only `TEST_ADMIN_DATABASE_URL` for that cluster and `PG_BIN`; no production or development secret was copied.
Browser runs used `E2E_PORT=5174`, `E2E_PREVIEW_PORT=4174`, `E2E_API_PORT=3101` (tablet) and
`E2E_API_PORT=3102`, `E2E_ADMIN_PORT=5176` (admin), because another checkout held 5173 and 3100.

| Suite | Result |
|---|---|
| Shared unit (Vitest) | 140 passed |
| Web unit (Vitest) | 349 passed |
| Admin unit (Vitest) | 34 passed |
| Deploy (Vitest, PowerShell 5.1) | 18 passed, 1 skipped (`caddy validate`: `CADDY_BIN` not set in this run) |
| API unit + integration on PG16 (Jest, `--maxWorkers=3`) | 752 total: 712 passed, 1 failed, 39 skipped |
| Tablet/PWA E2E (Playwright, all projects, no filter, no retries) | 76 passed |
| Admin E2E (Playwright, no filter, no retries) | 30 passed |
| `pnpm typecheck`, `pnpm lint` | exit 0 |

**API skips (39, all conditional):** S3 contract 30 and S3 orphan sweep 2 (`TEST_S3_ENDPOINT` not set),
real master-data import 6 (`MASTER_DATA_DIR` not set), real PO-export search performance 1.

**API failure (1), classified as a test flake, not a product regression and not caused by Phase 5:**
`admin-auth.db.spec.ts` › "refuses a missing, tampered, expired or tablet-audience cookie" expected 401 and
got 200 in the full run; the spec passed alone (15/15). The test "tampers" a token by replacing its last two
characters with `xx`. `jwt.ts` compares the decoded signature bytes, and base64url's last character carries
unused padding bits, so that edit sometimes leaves the signature bytes unchanged: measured 22 of 20,000
random HMAC signatures (about 1 in 900). Phase 5 commits did not touch `src/auth` or this spec. Not fixed here
(outside the validation-priority scope); recommended fix: tamper a character in the middle of the signature.

**IMPOSSIBLE before EMPTY, checked end to end.** `flow.spec.ts` › "impossible partial with quantity null/2
cannot seal or synchronize" passed for both cases through the real API: the "Defect melebihi jumlah pasang"
dialog shows (and "QTY INSPECTION belum diisi" does not), the outbox stays empty and no submission row exists
for the tablet. Findings stay intact: `QtyInspectionDialog.test.tsx` asserts all 3 recorded findings remain
after the refused SUBMIT PO and `submitPo` rejection, and the shared tests assert the check never changes
the findings.

## Revision and dependency evidence

- T5.4 baseline: `bcbfef4f054d900d27253e818b143ceb74861ff4`.
- Corrected ADR-019: `e18eb101cd41b574c99acf7dbc2ec901179b37ae`.
- [Documentation PR #22](https://github.com/WildanPratama02/mobile-100-inspection/pull/22)
  merged normally at 2026-10-28 06:52:04 UTC as `112413c531fcebbc38ecd4d9ceefbdf66084e9a0`.
  The exact head was checked at merge. No required checks, protection or reviews were
  configured; this is not independent reviewer approval.
- Feature synchronized with main: `788e99f5e9d02bf91b09bdcbf19903b095b7a402`.
  The corrected documentation is an ancestor of main and this branch.
- Remediation commits are recorded in the final handoff and Git history. Evidence
  covers the synchronized remediation source before documentation-only report commits.
  No implementation merge, deployment or implementation PR was performed.

The initial review covered all 73 changed files. Ten documentation files ceased to
be feature changes after PR #22 merged. Remediation changes quantity validation/tests,
PostgreSQL tool argument ordering, the recovery test/runbook, the rollback guard and
runbook packaging. No dependencies, credentials or historical migrations were changed.
The original review and diff are preserved under `test-results/phase5/`.

## Executed checks

Local gitignored artifacts are under `test-results/phase5-remediation/`.

| Check | Result | Artifact |
|---|---|---|
| Shared | PASS: 133 passed | shared-unit.json |
| Web unit | PASS: 349 passed | web-unit.json |
| API unit/integration, PostgreSQL 16 | PASS: 713 passed, 39 skipped | api-unit.json |
| Admin unit | PASS: 34 passed | admin-unit.json |
| Deployment, PowerShell 5.1, installed Caddy | PASS: 19 passed, no skips | deploy-unit.json |
| Complete tablet/PWA E2E rerun | PASS: 76 passed, no skips | web-e2e.json |
| Complete admin E2E | PASS: 30 passed, no skips | admin-e2e.json |
| Focused backup/restore rerun | PASS: 8 passed, included in API total | recovery-targeted.json |
| Typecheck, lint, formatting and workspace build | PASS: all exit 0 | regression-runs.json and logs |
| Migration, historical calculations and old-writer/UI probes | PASS: expected results reproduced on PG16 | runtime-probes.json |

Total: **1,248 unit/integration tests passed, 39 conditional skips; 106 E2E passed**. Packages ran
sequentially with two workers. Browser runs have no file/project/title filter or
automatic retries. The focused eight recovery tests are not counted twice.

The first PG16 run exposed Windows pg_restore rejecting a connection option placed
after the positional dump filename. The fix puts connection options first; all eight
recovery tests and the full API suite then passed. Test setup was also corrected:
non-admin roles now require SCRAM (the initial trust configuration incorrectly
accepted a wrong password), and the pre-0006 fixture filters the full migration
version name. Initial failures are retained in `api-unit-initial.*`.

The first full Web run had 75 passes and one setup failure: its trace records
`net::ERR_CONNECTION_REFUSED` fetching Vite's `/src/main.tsx`, before the five-photo
submission scenario started. Evidence is retained in `web-e2e-initial.*` and
`web-initial-failure-trace.zip`. The final full Web rerun passed all 76 tests
without retries, including the five-photo scenario. `final-runs.json` records
the successful API/Web/deployment reruns; initial failures remain disclosed.

## Acceptance and release verification matrix

| Gate | Status | Evidence and limit |
|---|---|---|
| Corrected ADR-019 on main; feature synchronized | PASS | PR #22 merge, ancestor check and synchronization commit above. |
| Full diff intentional | PASS | Original full review plus remediation diff; no old migration or dependency edits. |
| T5.1 manual quantity and findings-based counting | PASS | Shared tests; one pair with multiple findings counts every finding. Probe: inspection 30, defect 11, A-Grade 19, RFT 0.63333. |
| IMPOSSIBLE precedes EMPTY for every min > max | PASS | Parameterized null/1/3/4 tests for order and partial limits; runtime probe returns IMPOSSIBLE for null. |
| Invalid totals preserve findings; no auto-raising quantity | PASS | Shared totals and Web dialog/Home tests; derived values suppressed while invalid. |
| UNDO and replay | PASS | Shared/Web tests: SET leaves undo history intact, undo does not change quantity, legacy NO_DEFECT handling covered. |
| T5.2 both formats, validation and idempotency | PASS | Complete API suite on PG16; invalid quantities and empty/impossible partial return 422 with no rows/photos. |
| Historical ADR-008 values unchanged | PASS | Full-row migration comparison and probe: A-Grade 18, RFT 0.60000 retained; only rule added. |
| Migration, constraints and immutability | PASS | PG16 migration/repeat checks; immutable mutation refused with 23001. |
| Invalid quantity cannot seal an outbox | PASS | Web empty/populated impossible-partial tests: submitPo rejects and outbox remains empty. |
| T5.3 full real-API, offline, retry, exports and synchronization | PASS | Final complete Web rerun: 76 passed, no retries; includes invalid-quantity no-write assertions, PWA offline and PDF/XLSX downloads. |
| Sealed legacy outbox bytes unchanged | PASS | Final legacy-outbox E2E compares received JSON bytes/hash and stored ADR-008 rule/totals through the real API. |
| T5.4 admin list/detail/CSV and both formats | PASS | All 30 admin browser tests, 34 unit tests and API reporting checks. |
| PG16 server and matching client tools | PASS | Isolated Windows PostgreSQL 16.15, version_num 160015, port 55416; postgres16.json; actual API/migration/restore tests. |
| Actual installation matches PG16 target | NOT VERIFIED | Inspected installation points to PostgreSQL 18/5432. Target-version reconciliation remains required; installed service unchanged. |
| Installed Caddy validates release configuration | PASS | v2.11.7 with dns.providers.cloudflare; real caddy validate, dummy validation token. Live TLS/certificate issuance not tested. |
| Photo backend identified | PASS | Installed .env says disk; directory exists. environment.json. API/Caddy were stopped: configured backend evidence, not live production evidence. |
| Mandatory disk storage tests | PASS | Complete API disk contract, sweep, submission/file cleanup, corruption and backup/restore checks; no disk tests skipped. |
| Old writer against 0006 | FAIL — unsupported recovery path | INSERT omitting counting_rule fails 23502 after its default is dropped. Old readiness expects 0005. |
| Old UI replay of ADR-019 | FAIL — unsupported recovery path | Main's reducer returns undefined for SET_QTY_INSPECTION; old API rejects manual request shape. |
| Unsafe code rollback guard | PASS | PowerShell 5.1 tests reject missing/added/edited migration histories. Manual and automatic fallback paths invoke guard before old code restarts. Not an SCM rehearsal. |
| Forward/coordinated recovery design executed operationally | NOT VERIFIED | Runbook defines preservation, both restore branches, reconciliation and loss risks. Documentation alone cannot pass this gate. |
| Pre-0006 backup and incident restore fixture | PASS — isolated scope | New recovery test verifies baseline restore, forward migration, complete incident restore with pre/post-backup ADR-008 and ADR-019, original audit rows, photo bytes, row equality and grants. |
| Actual pre-release backup plus disconnected device reconciliation | NOT VERIFIED | No actual server backup restored or physical IndexedDB export restored. Partial-evidence delta reconciliation tool not implemented/rehearsed. |
| Windows SCM restart, reboot, ACLs and cross-machine restore | NOT VERIFIED | Session is not elevated. Installed services stayed stopped; secret-file metadata inaccessible under operator ACL. No ACL changes attempted. |
| Readiness before reopening ingestion | NOT VERIFIED | Upgrade still checks liveness only. Runbook requires device-authenticated system/status and both-format submissions before reopening; actual service procedure untested. |
| Physical-device offline/outbox | NOT VERIFIED | Samsung SM-T225/Android 12 detected and authorized; user then requested local-browser verification. No completed device journey or target Redmi test. |
| Full-duration T3.7 load/fault rehearsal | NOT VERIFIED | Separate default-excluded suite not run; ordinary E2E is not its substitute. |
| Approved RTO/RPO and deployment-scale recovery timing | NOT VERIFIED | Targets unset; fixture restore timings cannot certify them. |

## The 40 previously skipped tests

| Group | Current status | Release significance |
|---|---|---|
| Caddy validation (1) | PASS | Resolved using the installed compatible binary. |
| S3 contract (30) and orphan sweep (2) | SKIPPED | Not mandatory for verified disk configuration. Mandatory if PHOTO_STORE switches to S3. |
| Real master-data import (6) | SKIPPED | MASTER_DATA_DIR absent. Required before importing/replacing real master data; fixtures do not prove that operation. |
| Real full-export PO search performance (1) | SKIPPED | Real dataset absent. Synthetic 33,996-PO search ran; actual pilot data performance remains unverified. |

Thus 39 conditional skips remain. Backup/restore ran. Load tests, physical-device
tests and Windows operations are explicitly listed above and are not hidden in this count.

## Recovery and release conditions

Use [the recovery runbook](phase5-recovery-runbook.md), included by the release
packager. Migration 0006 is an intentional compatibility boundary. No schema
downgrade or application-only rollback is declared safe.

Prefer a compatible forward repair. If pre-migration restoration is necessary,
preserve incident database/config/photos, immutable audit records and all device
state first; restore the verified baseline and matching application in isolation.
Quarantine new local events from the old UI. A complete incident snapshot restored
with compatible Phase 5 code preserves accepted post-backup data without HTTP
regeneration of original immutable records.

When only partial evidence survives, reconciliation requires UUID/hash and full-row
comparison, original audit IDs/timestamps/actors, every photo verified, conflicts
quarantined and only genuinely unaccepted sealed bytes resent. That contingency
requires a separately reviewed tool and rehearsal. A pre-backup dump alone can lose
acknowledged submissions whose local copies are gone. Destroyed evidence, missing
photos or cleared device storage can cause irreversible loss.

**HOLD remains** until mandatory environment, service recovery, actual backup,
device reconciliation and readiness gates have executed evidence. No implementation
PR, merge, deployment or production-readiness claim follows from this report.
*(Superseded on 29 Oct 2026 by the owner's fast-track decision F1: the gate set is now G1–G9 of
`phase5-release-preparation.md` §8 and the implementation PR is authorized; see the verdict at the top.)*

