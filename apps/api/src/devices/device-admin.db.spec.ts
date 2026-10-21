import { createHash } from 'node:crypto';
import { Database } from '../db/database';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import {
  addDevices,
  DeviceCommandError,
  listDevices,
  pgDeviceAdminRepositories,
  revokeDevice,
} from './device-admin';
import { setupSheetHtml } from './setup-sheet';
import { parseTabletsCsv } from './tablets-csv';

const HOST = 'm100.qdms.web.id';
let testDb: TestDatabase;
let db: Database;

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  // As the CLI runs: role m100_app (doc 03 §6).
  db = new Database(testDb.pool('m100_app'));
});

afterAll(async () => {
  await testDb?.drop();
});

const repos = () => pgDeviceAdminRepositories(db);

async function deviceCount(): Promise<number> {
  const { rows } = await testDb.client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM devices',
  );
  return rows[0]!.n;
}

async function auditRows(actor: string) {
  const { rows } = await testDb.client.query<{
    action: string;
    entity: string;
    entity_id: string | null;
    details: Record<string, unknown>;
  }>('SELECT action, entity, entity_id, details FROM audit_log WHERE actor = $1 ORDER BY id', [
    actor,
  ]);
  return rows;
}

describe('device:add (doc 03 §7.5)', () => {
  it('stores only the SHA-256 of the key and writes an audit row', async () => {
    const [device] = await addDevices(db, repos(), ['Tablet F3-01'], HOST);
    expect(device).toMatchObject({ label: 'Tablet F3-01' });
    expect(device!.link).toBe(`https://${HOST}/setup#k=${device!.key}`);
    const { rows } = await testDb.client.query<Record<string, unknown>>(
      'SELECT * FROM devices WHERE id = $1',
      [device!.id],
    );
    expect(rows[0]!.key_sha256).toEqual(createHash('sha256').update(device!.key).digest());
    // The key itself is in no column.
    expect(JSON.stringify(rows[0])).not.toContain(device!.key);
    const audit = await auditRows('script:device:add');
    expect(audit).toEqual([
      {
        action: 'add',
        entity: 'devices',
        entity_id: device!.id,
        details: { label: 'Tablet F3-01' },
      },
    ]);
    const { rows: all } = await testDb.client.query('SELECT * FROM audit_log');
    expect(JSON.stringify(all)).not.toContain(device!.key);
  });

  it('creates 40 keys and one printable sheet from a batch of 40 unique labels', async () => {
    const csv = ['label', ...Array.from({ length: 40 }, (_, i) => `Batch ${i + 1}`)].join('\n');
    const before = await deviceCount();
    const issued = await addDevices(db, repos(), parseTabletsCsv(csv), HOST);
    expect(issued).toHaveLength(40);
    expect(new Set(issued.map((d) => d.key)).size).toBe(40);
    expect(await deviceCount()).toBe(before + 40);
    expect(await auditRows('script:device:add')).toHaveLength(41);
    const html = await setupSheetHtml(issued);
    expect(html.match(/<svg /g)).toHaveLength(40);
  });

  it('refuses a label given twice in the batch, and creates nothing', async () => {
    const before = await deviceCount();
    await expect(
      addDevices(db, repos(), parseTabletsCsv('label\nNew 1\nNew 2\nNew 1\n'), HOST),
    ).rejects.toThrow(/more than once: "New 1"/);
    expect(await deviceCount()).toBe(before);
  });

  it('refuses a label that is already registered, and creates nothing', async () => {
    const before = await deviceCount();
    const error = await addDevices(db, repos(), ['New 3', 'Tablet F3-01'], HOST).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DeviceCommandError);
    expect((error as Error).message).toMatch(/already registered.*"Tablet F3-01"/);
    expect(await deviceCount()).toBe(before);
    expect(await auditRows('script:device:add')).toHaveLength(41);
  });

  it.each([[[]], [['']], [[' padded']], [['x'.repeat(101)]]])(
    'refuses the labels %j',
    async (labels) => {
      await expect(addDevices(db, repos(), labels, HOST)).rejects.toThrow(DeviceCommandError);
    },
  );
});

describe('device:revoke', () => {
  it('sets revoked_at once and writes an audit row each time', async () => {
    const first = await revokeDevice(db, repos(), 'Batch 1');
    expect(first.alreadyRevoked).toBe(false);
    expect(first.device.revokedAt).toBeInstanceOf(Date);
    const second = await revokeDevice(db, repos(), 'Batch 1');
    expect(second.alreadyRevoked).toBe(true);
    expect(second.device.revokedAt).toEqual(first.device.revokedAt);
    expect(await auditRows('script:device:revoke')).toEqual([
      {
        action: 'revoke',
        entity: 'devices',
        entity_id: first.device.id,
        details: { label: 'Batch 1', alreadyRevoked: false },
      },
      {
        action: 'revoke',
        entity: 'devices',
        entity_id: first.device.id,
        details: { label: 'Batch 1', alreadyRevoked: true },
      },
    ]);
  });

  it('names a label that does not exist and writes nothing', async () => {
    await expect(revokeDevice(db, repos(), 'Nope')).rejects.toThrow(
      'No device has the label "Nope"',
    );
    expect(await auditRows('script:device:revoke')).toHaveLength(2);
  });
});

describe('device:list', () => {
  it('lists every device by label, revoked ones included, and writes an audit row', async () => {
    const devices = await listDevices(db, repos());
    expect(devices).toHaveLength(41);
    expect(devices.map((d) => d.label)).toContain('Tablet F3-01');
    expect(devices.find((d) => d.label === 'Batch 1')?.revokedAt).toBeInstanceOf(Date);
    expect(await auditRows('script:device:list')).toEqual([
      { action: 'list', entity: 'devices', entity_id: null, details: { count: 41 } },
    ]);
  });
});
