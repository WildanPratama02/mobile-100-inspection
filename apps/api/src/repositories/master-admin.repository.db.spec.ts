import { Database } from '../db/database';
import { AdminDataSource } from '../db/typeorm';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { PgAuditLogRepository } from './audit-log.repository';
import { TypeOrmMasterAdminRepository } from './master-admin.repository';
import { PgSettingsRepository } from './settings.repository';

let testDb: TestDatabase;
let source: AdminDataSource;
let repo: TypeOrmMasterAdminRepository;
const settings = () => new PgSettingsRepository(new Database(testDb.pool('m100_app')));

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  // As the API runs: role m100_app, whose grants allow SELECT, INSERT and UPDATE only.
  source = new AdminDataSource(testDb.url('m100_app'));
  repo = new TypeOrmMasterAdminRepository(source);
  await testDb.client.query(
    `INSERT INTO factories (name) VALUES ('F 1'), ('F 2');
     INSERT INTO cells (factory_id, code) VALUES (2, 'F2-01'), (1, 'F1-01');
     INSERT INTO psi_users (username, level, active) VALUES ('ZAINAB', 'PSI lv.1', true),
       ('AZIZAH', 'PSI lv.2', false), ('AZIZAH', 'PSI lv.1', true);
     INSERT INTO pos (po, article, model, destination, order_qty, podd, crd, source)
       VALUES ('0902028839', 'AB1234', E'RUNNER\\u00A0X', 'ID', 1200, '2026-01-12', NULL, 'import:fixture.xlsx');`,
  );
});

afterAll(async () => {
  await testDb.allowConnections(true).catch(() => undefined);
  await source?.destroy();
  await testDb?.drop();
});

describe('TypeOrmMasterAdminRepository (doc 02 §5.2, doc 03 §5.1)', () => {
  it('lists every row, active or not, in a fixed order', async () => {
    expect(await repo.psiUsers()).toEqual([
      { id: 3, username: 'AZIZAH', level: 'PSI lv.1', active: true },
      { id: 2, username: 'AZIZAH', level: 'PSI lv.2', active: false },
      { id: 1, username: 'ZAINAB', level: 'PSI lv.1', active: true },
    ]);
    expect(await repo.cells()).toEqual([
      { id: 1, factoryId: 2, code: 'F2-01', active: true, factory: 'F 2' },
      { id: 2, factoryId: 1, code: 'F1-01', active: true, factory: 'F 1' },
    ]);
    expect(await repo.cells(1)).toEqual([
      { id: 2, factoryId: 1, code: 'F1-01', active: true, factory: 'F 1' },
    ]);
  });

  it('reads a PO with its dates as YYYY-MM-DD and its text byte for byte', async () => {
    const po = await repo.transaction((tx) => tx.find('pos', '0902028839'));
    expect(po).toEqual({
      po: '0902028839',
      article: 'AB1234',
      model: 'RUNNER\u00a0X',
      destination: 'ID',
      orderQty: 1200,
      podd: '2026-01-12',
      crd: null,
      finished: null,
      active: true,
      source: 'import:fixture.xlsx',
    });
  });

  it('inserts and updates in one transaction with the audit row and the version bump, touching updated_at', async () => {
    const before = await settings().masterVersion();
    const audit = new PgAuditLogRepository(new Database(testDb.pool('m100_app')));
    const user = await repo.transaction(async (tx) => {
      const created = await tx.insert('psi_users', {
        username: 'BUDI',
        level: 'PSI lv.2',
        active: true,
      });
      const updated = await tx.update('psi_users', created.id, { username: 'BUDI S' });
      await audit.append({ actor: 'admin:qip', action: 'create', entity: 'psi_users' }, tx.q);
      await settings().bumpMasterVersion(tx.q);
      return updated;
    });
    expect(user).toEqual({
      id: expect.any(Number) as number,
      username: 'BUDI S',
      level: 'PSI lv.2',
      active: true,
    });
    expect(await settings().masterVersion()).toBe(before + 1);
    // now() is the transaction's start, so the touch shows only in a later transaction.
    await repo.transaction((tx) => tx.update('psi_users', user.id, { active: false }));
    const { rows } = await testDb.client.query<{ changed: boolean }>(
      `SELECT updated_at > created_at AS changed FROM psi_users WHERE id = $1`,
      [user.id],
    );
    expect(rows[0]?.changed).toBe(true);
  });

  it('rolls everything back, the audit row and the bump included, when the transaction throws', async () => {
    const before = await settings().masterVersion();
    const { rows: audits } = await testDb.client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log',
    );
    await expect(
      repo.transaction(async (tx) => {
        await tx.insert('factories', { name: 'F 9', active: true });
        await new PgAuditLogRepository(new Database(testDb.pool('m100_app'))).append(
          { actor: 'admin:qip', action: 'create', entity: 'factories' },
          tx.q,
        );
        await settings().bumpMasterVersion(tx.q);
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect((await repo.factories()).map((f) => f.name)).toEqual(['F 1', 'F 2']);
    expect(await settings().masterVersion()).toBe(before);
    const { rows } = await testDb.client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log',
    );
    expect(rows[0]!.n).toBe(audits[0]!.n);
  });

  it('fails a duplicate natural key with the unique violation 23505', async () => {
    await expect(
      repo.transaction((tx) => tx.insert('cells', { factoryId: 1, code: 'F2-01', active: true })),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      repo.transaction((tx) => tx.update('psi_users', 3, { level: 'PSI lv.2' })),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('opens again after the database was unreachable at first use', async () => {
    const late = new AdminDataSource(testDb.url('m100_app'));
    try {
      await testDb.allowConnections(false);
      await expect(late.get()).rejects.toBeDefined();
      await testDb.allowConnections(true);
      expect((await new TypeOrmMasterAdminRepository(late).factories()).length).toBe(2);
    } finally {
      await testDb.allowConnections(true);
      await late.destroy();
    }
  });
});
