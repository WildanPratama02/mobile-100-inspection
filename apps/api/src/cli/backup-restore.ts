/**
 * `pnpm backup:restore --from <backup folder> --database <name> [--keep] [--replace] [--photos <dir>]`
 * (doc 03 §7.6). The restore test: restores the dump into the new database `<name>`, checks counts and photos
 * against the manifest and drops it again (`--keep` leaves it). Recovery: `--replace --database m100` drops and
 * restores the live database; stop the API first. Needs `ADMIN_DATABASE_URL` (a PostgreSQL superuser), and
 * `PG_BIN` when `pg_restore` is not on `PATH`. Exits 1 when a check fails.
 */
import { parseArgs } from 'node:util';
import { restoreBackup } from '../backup/restore';
import { fromInvocationDir, loadCliEnv, requireEnv } from './device-env';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      database: { type: 'string' },
      photos: { type: 'string' },
      keep: { type: 'boolean', default: false },
      replace: { type: 'boolean', default: false },
    },
  });
  if (!values.from || !values.database) {
    throw new Error(
      'Usage: backup:restore --from <backup folder> --database <name> [--keep] [--replace]',
    );
  }
  loadCliEnv();
  const report = await restoreBackup({
    from: fromInvocationDir(values.from),
    adminUrl: requireEnv('ADMIN_DATABASE_URL'),
    database: values.database,
    replace: values.replace,
    keep: values.keep,
    photosDir: values.photos ? fromInvocationDir(values.photos) : undefined,
    pgBin: process.env.PG_BIN?.trim() || undefined,
  });
  const m = report.manifest;
  const lines = [
    `Backup ${m.name} (${m.kind}, release ${m.release ?? '-'}) restored into ${report.database}.`,
    `Submissions: ${report.submissions} (backup: ${m.submissions})`,
    `Photo rows: ${report.submissionPhotos} (backup: ${m.submissionPhotos})`,
    m.photos === 'mirrored'
      ? `Photo files: ${report.missingPhotos.length} missing, ${report.photosChecked} opened, ${report.badPhotos.length} not JPEG`
      : 'Photo files: not in this backup (S3 store)',
    ...report.missingPhotos.slice(0, 20).map((k) => `  missing ${k}`),
    ...report.badPhotos.map((k) => `  not a JPEG ${k}`),
    report.dropped
      ? `Database ${report.database} dropped again.`
      : `Database ${report.database} kept.`,
    report.ok ? 'Restore check passed.' : 'Restore check FAILED.',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (!report.ok) process.exit(1);
}

main().catch((error: unknown) => {
  process.stderr.write(`backup:restore failed: ${(error as Error).message}\n`);
  process.exit(1);
});
