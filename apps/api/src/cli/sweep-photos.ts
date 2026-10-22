/**
 * `pnpm sweep-photos [--dry-run]` (doc 02 §6.2, doc 03 §7.4): removes photos older than 24 hours that no
 * `submission_photos` row points to. Run it weekly, `--dry-run` first. Reads the API's `.env` (`DATABASE_URL` and the
 * photo store of `PHOTO_STORE`) and writes one `audit_log` row per real run.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/env';
import { PgAuditLogRepository } from '../repositories/audit-log.repository';
import { PgSubmissionRepository } from '../repositories/submission.repository';
import { createPhotoStore } from '../photos/photo-store.module';
import { S3PhotoStore } from '../photos/s3-photo-store';
import { sweepPhotos } from '../photos/sweep-photos';
import { loadCliEnv, openDatabase } from './device-env';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
  const dryRun = values['dry-run'];
  loadCliEnv();
  const config = loadConfig(process.env);
  const store = createPhotoStore(config.photoStore);
  const db = openDatabase('sweep-photos');
  try {
    const report = await sweepPhotos(
      {
        store,
        submissions: new PgSubmissionRepository(db),
        auditLog: new PgAuditLogRepository(db),
      },
      { dryRun },
    );
    for (const key of report.orphans) {
      process.stdout.write(`${dryRun ? 'would delete' : 'deleted'}  ${key}\n`);
    }
    process.stdout.write(
      `${report.scanned} objects, ${report.old} older than 24 hours, ${report.orphans.length} of those without ` +
        `a submission: ${dryRun ? 'dry run, nothing deleted' : 'deleted'}.\n`,
    );
  } finally {
    await db.end();
    if (store instanceof S3PhotoStore) store.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`sweep-photos failed: ${(error as Error).message}\n`);
  process.exit(1);
});
