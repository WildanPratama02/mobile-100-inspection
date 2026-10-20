import { createHash, randomUUID } from 'node:crypto';
import { Database } from '../db/database';
import { createTestDatabase, sqlState, type TestDatabase } from '../testing/database';
import { PgDeviceRepository } from './device.repository';

let db: TestDatabase;
let repo: PgDeviceRepository;

const UNIQUE_VIOLATION = '23505';
const hashOf = (key: string): Buffer => createHash('sha256').update(key).digest();

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  repo = new PgDeviceRepository(new Database(db.pool('m100_app')));
});
afterAll(async () => {
  await db?.drop();
});

describe('PgDeviceRepository (doc 02 §5.3, ADR-014)', () => {
  const id = randomUUID();

  it('stores a device with the SHA-256 of its key and finds it by that hash', async () => {
    const added = await repo.insert({ id, label: 'Tablet F3-01', keySha256: hashOf('key one') });
    expect(added).toMatchObject({ id, label: 'Tablet F3-01', revokedAt: null, lastSeenAt: null });
    expect(added.keySha256.equals(hashOf('key one'))).toBe(true);
    expect(added.createdAt).toBeInstanceOf(Date);

    expect((await repo.findByKeySha256(hashOf('key one')))?.id).toBe(id);
    expect(await repo.findByKeySha256(hashOf('another key'))).toBeNull();
    expect((await repo.findByLabel('Tablet F3-01'))?.id).toBe(id);
  });

  it('refuses a label or a key hash that is already taken', async () => {
    expect(
      await sqlState(
        repo.insert({ id: randomUUID(), label: 'Tablet F3-01', keySha256: hashOf('key two') }),
      ),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await sqlState(
        repo.insert({ id: randomUUID(), label: 'Tablet F3-02', keySha256: hashOf('key one') }),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('records when a device was last seen', async () => {
    await repo.touchLastSeen(id);
    expect((await repo.findByLabel('Tablet F3-01'))?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('revokes once; a revoked device is still found, so the guard can refuse it', async () => {
    const revoked = await repo.revoke('Tablet F3-01');
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    const again = await repo.revoke('Tablet F3-01');
    expect(again?.revokedAt).toEqual(revoked?.revokedAt);
    expect((await repo.findByKeySha256(hashOf('key one')))?.revokedAt).toEqual(revoked?.revokedAt);
    expect(await repo.revoke('Tablet F9-99')).toBeNull();
  });

  it('lists every device by label, revoked ones included', async () => {
    await repo.insert({ id: randomUUID(), label: 'Tablet F1-01', keySha256: hashOf('key three') });
    expect((await repo.list()).map((d) => [d.label, d.revokedAt !== null])).toEqual([
      ['Tablet F1-01', false],
      ['Tablet F3-01', true],
    ]);
  });
});
