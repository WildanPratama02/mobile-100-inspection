# Phase 5 recovery and release procedure

Status: **HOLD — rehearsal results are in phase5-integration-review.md.**
This procedure does not authorize a production cutover. Commands below are Windows
PowerShell 5.1 syntax. Service operations need an elevated session on a dedicated
staging installation before approval for production.

## Compatibility boundary

Migration `0006_manual_qty_inspection.sql` adds `counting_rule NOT NULL DEFAULT
'ADR-008'` to classify historical rows, then **drops the default**. The old INSERT
does not name that column and fails with SQLSTATE **23502**, column
`counting_rule`. Relaxing `qty_no_defect` and replacing sum/A-Grade constraints
allows ADR-019 rows; those rows cannot be represented by the old constraints.
The old API also rejects the new strict counts shape and expects migration 0005
instead of 0006. HTTP 200 from /v1/health is liveness only.

The old tablet reducer has no SET_QTY_INSPECTION case. Its switch falls through
to undefined on that persisted event; subsequent replay cannot reconstruct the
session. Old clients also cannot interpret manual quantities. Keep the compatible
tablet shell/service worker and local storage, even during a server outage.
Previously sealed ADR-008 outbox JSON can still be sent unchanged to the new API.

**Application-only rollback and schema downgrade are unsupported across 0006.**
The upgrade script now refuses manual/automatic fallback with differing or missing
migration histories, including migration failure after a possible partial upgrade.
An identical history is only a necessary check, not proof of application compatibility.
Use the new script from the verified release; an old script lacks this guard.

## Preferred response: forward recovery

1. Freeze ingestion and master-data changes. Stop the site's API/Caddy services,
   disable scheduled writes/sweep/backup retention and restrict operator access.
   Record UTC time, database/schema version, releases, device list and incident ID.
   Preserve logs and the failed release. Never clear browser data or reinstall
   clients. Keep devices offline until their state is captured.
2. Preserve an incident database dump, configuration/secrets, all disk photos,
   immutable audit rows and each device's IndexedDB before attempting recovery.
   Use an incident-specific backup directory so retention cannot remove evidence.
   Restrict access to backup secrets and device credentials; do not place them in Git.
3. Reproduce in isolated restored databases. Fix forward with a release that retains
   both request formats, migration 0006, immutable stored calculations and the new
   event reducer. Do not edit applied migration files or recalculate old submissions.
4. Validate authenticated /v1/system/status, master version, submit-enabled setting,
   disk storage, both formats, idempotent retry, reporting and outbox drain before
   exposing the repaired installation. Liveness alone is insufficient.

## Backup and restore commands (staging first)

Set these to the isolated installation, its verified unpacked release, matching
PostgreSQL 16 tools and an existing complete pre-0006 backup. Obtain superuser
credentials through the approved secret mechanism; do not put them in transcripts.
Keep the original installation and backups untouched. Do not use --replace in rehearsals.

```powershell
$ErrorActionPreference = 'Stop'
$StageRoot = 'D:\M100-rehearsal'
$ReleaseDir = 'D:\M100-rehearsal\releases\phase5'
$PreBackup = 'E:\M100-preserved\pre-upgrade\verified-backup'
$env:PG_BIN = 'C:\Program Files\PostgreSQL\16\bin'
$ScratchName = 'm100_rehearsal_pre0006'
# Set ADMIN_DATABASE_URL securely for the isolated PostgreSQL 16 cluster.
if (-not $env:ADMIN_DATABASE_URL) { throw 'Missing isolated admin connection' }
if ($ScratchName -notmatch '^m100_rehearsal_[a-z0-9_]+$') { throw 'Invalid scratch name' }
$manifest = Get-Content -LiteralPath (Join-Path $PreBackup 'manifest.json') -Raw | ConvertFrom-Json
$dump = Join-Path $PreBackup $manifest.dump.file
if ((Get-FileHash -LiteralPath $dump -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.dump.sha256) {
    throw 'Backup checksum mismatch'
}
& (Join-Path $env:PG_BIN 'pg_restore.exe') --list $dump
if ($LASTEXITCODE -ne 0) { throw 'Unreadable dump' }
# Run from an empty staging folder, with no production .env or INIT_CWD.
Remove-Item Env:\INIT_CWD -ErrorAction SilentlyContinue
Set-Location -LiteralPath $StageRoot
& node (Join-Path $ReleaseDir 'api\dist\cli\backup-restore.js') --from $PreBackup --database $ScratchName --keep
if ($LASTEXITCODE -ne 0) { throw 'Restore verification failed' }
```

The restore CLI verifies dump SHA-256, submission/photo-row counts, existence of
every referenced mirrored photo, and sampled JPEG signatures. Additionally compare
**every** photo's bytes with its recorded hash and compare all immutable rows,
timestamps, UUIDs, payload hashes and totals; counts alone are not sufficient.
The photo mirror is the backup root's photos directory shared across backup folders;
preserve it with the dump, not just the dated backup folder. Protect .env/secrets
and preserve their ACLs. Verify JWT key continuity and device registration state.

Before migration, create the pre-upgrade backup using the installation's configured
backup CLI. For incident preservation use the still compatible release and override
BACKUP_DIR with a new protected incident directory, then verify the returned folder:

```powershell
# Only in the isolated installation until separately approved.
$env:BACKUP_DIR = 'E:\M100-preserved\incident-unique-id'
& node (Join-Path $ReleaseDir 'api\dist\cli\backup.js') --kind pre-upgrade
if ($LASTEXITCODE -ne 0) { throw 'Incident preservation failed' }
# Record hash manifests for dump/config/photos/client exports separately.
# Restore this incident backup into a SECOND uniquely named scratch database
# using the same backup-restore command; never overwrite the pre-0006 restore.
```

## Coordinated application/database restore

A verified pre-migration backup must be restored and tested first. Select its exact
matching API/admin/database version and archived client assets. Restoring that pair
does not make old tablet replay safe: isolate all devices with SET_QTY_INSPECTION
events, preserve them and keep ingestion stopped. Do not downgrade their site data.
If service must resume with those devices, migrate the restored copy forward and
use the compatible Phase 5 application instead.

Keep the incident source database, dumps and complete photo mirror read-only.
Preferred lossless server recovery is restoring a verified complete incident snapshot
into a new database with matching Phase 5 code. That preserves accepted post-backup
submissions and original audit records without regenerating them through HTTP.
The automated recovery test verifies the pre-0006 restore, forward migration, then
incident restore with complete row equality for both formats/findings/photos/audit.

If only a pre-backup baseline and partial incident evidence survive, a separately
reviewed reconciliation tool and rehearsal are required before cutover:

- Inventory by submission UUID, original payload SHA-256 and photo SHA-256. Compare
  complete immutable rows, including original display number, received/sealed times,
  rule, totals and child rows. Keep ADR-008 values unchanged.
- Existing UUID + identical data: retain once. Different hash/metadata, missing
  children/photos or conflicting display number: quarantine and stop; never overwrite.
- Insert missing accepted server rows and original audit records with their original
  identifiers/actor/time/details in dependency order into the offline recovered copy,
  using reviewed owner-only tooling. Preserve identity values and reset sequences
  above maxima before accepting writes. Never UPDATE/DELETE immutable source records.
- Preserve all audit entries, not merely those associated with submissions. Retain
  the original incident artifacts and add a separate recovery operation log with
  source/target manifests, approvals and conflict decisions.
- Compare each client outbox UUID/hash against recovered server rows. Already
  accepted identical rows get the same idempotent acknowledgement. Resend genuinely
  unaccepted sealed records **byte-for-byte**, including photos; never reseal or
  convert noDefect/qtyInspection. Preserve open session events and sequence numbers.
- Export IndexedDB stores including auth, events, sessions, PO state, photo blobs
  and outbox, plus origin/browser profile identity. Verify export restoration in a
  separate test profile. Secure credentials. A screenshot or payload-only export
  is not a restorable device backup.

The partial-evidence reconciliation tool is **not implemented or rehearsed**.
Do not claim this contingency is executable end to end. Until it is, keep HOLD
unless complete incident-snapshot recovery meets the agreed recovery scenario.
The existing restore.ps1 -Full destructively restores configuration/database and
starts services; it is not an approved Phase 5 rollback shortcut.

## Release and rehearsal acceptance criteria

Release only after every mandatory gate has measured evidence:

1. Exact release archive, unchanged migration checksums and corrected ADR-019;
   PostgreSQL 16 server AND tools verified; full relevant tests pass.
2. Verified pre-0006 backup restored on another Windows staging environment;
   disk/config/JWT/device keys, ACLs and all photo hashes checked. Corrupt or
   incomplete backups fail closed. Record measured backup/restore duration and
   compare against a named, approved RTO/RPO; these targets remain unset.
3. Seed pre-backup ADR-008 plus post-backup ADR-008/ADR-019, photographs, original
   audit entries and a disconnected device with both sealed and open work.
   Rehearse forward recovery and coordinated restore, then reconcile without
   loss, duplication, recalculation or modification of original audit records.
4. Service-manager stop/start and host reboot at failure boundaries; no old writer
   starts against 0006, readiness blocks ingestion until compatible, queued work
   survives restart. Validate actual WinSW identities, ACLs, TLS/Caddy and scheduling.
5. Physical target-device offline/reload/reconnect, retries, exports and outbox drain;
   compare bytes/hashes and server rows. Desktop emulation cannot satisfy this gate.
6. Cutover only after reconciliation and operator sign-off. Record active code,
   schema, photo directory, secrets, manifests, pending outboxes and conflict count.
   Keep old databases and incident backups intact for the approved retention period.

**Data-loss risk:** a pre-backup restore alone loses every subsequently accepted
write not recovered from incident evidence. Client acknowledgement can already
have removed its local copy. Lost/cleared devices, unexported open sessions,
missing photos, unreadable dumps or destroyed audit rows may be unrecoverable.
Nightly backups imply a potential interval since the last verified backup, not
a guaranteed 24-hour bound. No zero-loss or RTO claim is made without evidence.
