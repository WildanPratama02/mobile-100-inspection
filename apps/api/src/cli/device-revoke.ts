/**
 * `pnpm device:revoke --label "<label>"` (doc 03 §7.5): a lost or retired tablet is cut off at once, also with an
 * unexpired PSI token. Needs `DATABASE_URL`.
 */
import { parseArgs } from 'node:util';
import {
  DeviceCommandError,
  pgDeviceAdminRepositories,
  revokeDevice,
} from '../devices/device-admin';
import { loadCliEnv, openDatabase, wib } from './device-env';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { label: { type: 'string' } } });
  if (!values.label) throw new DeviceCommandError('Usage: pnpm device:revoke --label "<label>"');
  loadCliEnv();
  const db = openDatabase('device:revoke');
  try {
    const { device, alreadyRevoked } = await revokeDevice(
      db,
      pgDeviceAdminRepositories(db),
      values.label,
    );
    process.stdout.write(
      alreadyRevoked
        ? `${device.label} was already revoked on ${wib(device.revokedAt)} WIB.\n`
        : `${device.label} is revoked (${wib(device.revokedAt)} WIB). Its key no longer works.\n`,
    );
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`device:revoke failed: ${(error as Error).message}\n`);
  process.exit(1);
});
