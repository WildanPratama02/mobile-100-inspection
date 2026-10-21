/**
 * Test helper: a registered tablet in a test database, with the key it would have got from `device:add`.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database';
import { generateDeviceKey, hashDeviceKey } from '../auth/device-key';

export interface TestDevice {
  id: string;
  label: string;
  key: string;
}

export async function registerDevice(
  db: Queryable,
  label = `Tablet ${randomUUID().slice(0, 8)}`,
): Promise<TestDevice> {
  const key = generateDeviceKey();
  const id = randomUUID();
  await db.query('INSERT INTO devices (id, label, key_sha256) VALUES ($1, $2, $3)', [
    id,
    label,
    hashDeviceKey(key),
  ]);
  return { id, label, key };
}
