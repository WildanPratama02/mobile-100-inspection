/**
 * `pnpm device:list` (doc 03 §7.4): every registered tablet with its state and last contact, never a key.
 * Needs `DATABASE_URL`.
 */
import { listDevices, pgDeviceAdminRepositories } from '../devices/device-admin';
import { loadCliEnv, openDatabase, wib } from './device-env';

async function main(): Promise<void> {
  loadCliEnv();
  const db = openDatabase('device:list');
  try {
    const devices = await listDevices(db, pgDeviceAdminRepositories(db));
    const rows = [
      ['LABEL', 'STATE', 'CREATED (WIB)', 'LAST SEEN (WIB)', 'ID'],
      ...devices.map((d) => [
        d.label,
        d.revokedAt ? `revoked ${wib(d.revokedAt)}` : 'active',
        wib(d.createdAt),
        wib(d.lastSeenAt),
        d.id,
      ]),
    ];
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
    for (const row of rows) {
      process.stdout.write(
        `${row
          .map((cell, i) => cell.padEnd(widths[i]!))
          .join('  ')
          .trimEnd()}\n`,
      );
    }
    process.stdout.write(`${devices.length} ${devices.length === 1 ? 'device' : 'devices'}.\n`);
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`device:list failed: ${(error as Error).message}\n`);
  process.exit(1);
});
