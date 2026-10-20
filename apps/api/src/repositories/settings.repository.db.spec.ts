import { Database } from '../db/database';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { PgSettingsRepository } from './settings.repository';

let db: TestDatabase;
let database: Database;
let settings: PgSettingsRepository;

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  database = new Database(db.pool('m100_app'));
  settings = new PgSettingsRepository(database);
});
afterAll(async () => {
  await db?.drop();
});

describe('PgSettingsRepository (doc 02 §3, §10)', () => {
  it('starts at master_version 0 with submitting enabled (migration 0002)', async () => {
    expect(await settings.masterVersion()).toBe(0);
    expect(await settings.submitEnabled()).toBe(true);
  });

  it('bumps master_version in the caller’s transaction, and a rollback undoes it', async () => {
    const before = await settings.masterVersion();
    const bumped = await database.transaction((tx) => settings.bumpMasterVersion(tx));
    expect(bumped).toBe(before + 1);
    expect(await settings.masterVersion()).toBe(before + 1);

    await expect(
      database.transaction(async (tx) => {
        await settings.bumpMasterVersion(tx);
        throw new Error('master change failed');
      }),
    ).rejects.toThrow('master change failed');
    expect(await settings.masterVersion()).toBe(before + 1);
  });

  it('gives every concurrent bump its own version', async () => {
    const before = await settings.masterVersion();
    const versions = await Promise.all(
      Array.from({ length: 10 }, () =>
        database.transaction((tx) => settings.bumpMasterVersion(tx)),
      ),
    );
    expect([...versions].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, i) => before + i + 1),
    );
    expect(await settings.masterVersion()).toBe(before + 10);
  });

  it('switches submitting off and on', async () => {
    await settings.setSubmitEnabled(false);
    expect(await settings.submitEnabled()).toBe(false);
    await settings.setSubmitEnabled(true);
    expect(await settings.submitEnabled()).toBe(true);
  });
});
