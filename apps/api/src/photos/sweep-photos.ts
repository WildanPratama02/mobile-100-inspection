/**
 * The weekly orphan sweep (doc 02 §6.2, doc 03 §5.4). Photos go into the store before the submission's transaction,
 * so a crash in between leaves objects without a `submission_photos` row; a retry overwrites them with the same
 * bytes. Objects older than 24 hours that no row points to are removed: by then the tablet has either retried (and a
 * retry's put renews the object's time) or never will. A real run writes one `audit_log` row; `--dry-run` only reports.
 *
 * The rows of one batch are checked right before its objects are deleted. A retry whose transaction commits in the
 * milliseconds between the two would lose its photos; that needs a retry arriving more than 24 hours after its first
 * attempt, at the moment of the weekly run, and is accepted rather than locked against.
 */
import type { AuditLogRepository } from '../repositories/audit-log.repository';
import type { SubmissionRepository } from '../repositories/submission.repository';
import type { PhotoStore } from './photo-store';

export const SWEEP_ACTOR = 'script:sweep-photos';
/** Doc 02 §6.2. An object exactly this old is kept. */
export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
/** Only what the API itself writes: submission photos and leftovers of an interrupted readiness probe. */
const SWEPT_PREFIXES = ['submissions/', '_probe/'];
const BATCH = 500;

export interface SweepDependencies {
  store: PhotoStore;
  submissions: Pick<SubmissionRepository, 'photoKeysInUse'>;
  auditLog: AuditLogRepository;
}

export interface SweepReport {
  dryRun: boolean;
  /** Objects in the store under `submissions/` and `_probe/`; anything else is never touched. */
  scanned: number;
  /** Of those, older than 24 hours. */
  old: number;
  /** Old objects without a `submission_photos` row: deleted, or on a dry run the ones that would be. */
  orphans: string[];
}

export async function sweepPhotos(
  deps: SweepDependencies,
  { now = new Date(), dryRun = false }: { now?: Date; dryRun?: boolean } = {},
): Promise<SweepReport> {
  const cutoff = now.getTime() - ORPHAN_AGE_MS;
  const report: SweepReport = { dryRun, scanned: 0, old: 0, orphans: [] };

  const old: string[] = [];
  for await (const photo of deps.store.list()) {
    if (!SWEPT_PREFIXES.some((prefix) => photo.key.startsWith(prefix))) continue;
    report.scanned++;
    if (photo.lastModified.getTime() < cutoff) old.push(photo.key);
  }
  report.old = old.length;
  old.sort();

  let failure: Error | undefined;
  try {
    for (let i = 0; i < old.length; i += BATCH) {
      const batch = old.slice(i, i + BATCH);
      const inUse = await deps.submissions.photoKeysInUse(batch);
      for (const key of batch) {
        if (inUse.has(key)) continue;
        if (!dryRun) await deps.store.delete(key);
        report.orphans.push(key);
      }
    }
  } catch (error) {
    failure = error as Error;
  }
  // Also after a failure part way, so every object that was deleted is on record.
  if (!dryRun) {
    try {
      await deps.auditLog.append({
        actor: SWEEP_ACTOR,
        action: 'sweep',
        entity: 'photos',
        details: {
          scanned: report.scanned,
          old: report.old,
          deleted: report.orphans.length,
          keys: report.orphans,
          ...(failure ? { failed: failure.message } : {}),
        },
      });
    } catch (error) {
      failure ??= error as Error;
    }
  }
  if (failure) throw failure;
  return report;
}
