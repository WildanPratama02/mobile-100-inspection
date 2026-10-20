import { Database } from '../db/database';
import { createTestDatabase, sqlState, type TestDatabase } from '../testing/database';
import { type Actor, PgAuditLogRepository } from './audit-log.repository';

let db: TestDatabase;
let database: Database;
let repo: PgAuditLogRepository;

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  database = new Database(db.pool('m100_app'));
  repo = new PgAuditLogRepository(database);
});
afterAll(async () => {
  await db?.drop();
});

describe('PgAuditLogRepository (doc 02 §5.2–5.3)', () => {
  it('appends a row with actor, action, entity and details as JSON', async () => {
    const row = await repo.append({
      actor: 'script:device:add',
      action: 'device:add',
      entity: 'devices',
      entityId: 'Tablet F3-01',
      details: { label: 'Tablet F3-01', old: null },
    });
    expect(row).toMatchObject({
      actor: 'script:device:add',
      action: 'device:add',
      entity: 'devices',
      entityId: 'Tablet F3-01',
      details: { label: 'Tablet F3-01', old: null },
    });
    expect(row.at).toBeInstanceOf(Date);

    const bare = await repo.append({
      actor: 'system',
      action: 'submit:disable',
      entity: 'settings',
    });
    expect(bare).toMatchObject({ entityId: null, details: null });
  });

  it('writes in the caller’s transaction, so a rolled-back change leaves no row', async () => {
    await expect(
      database.transaction(async (tx) => {
        await repo.append({ actor: 'admin:qip', action: 'cell:rename', entity: 'cells' }, tx);
        throw new Error('change failed');
      }),
    ).rejects.toThrow('change failed');
    expect((await repo.list()).map((r) => r.action)).not.toContain('cell:rename');
  });

  it('refuses an actor that is not system, admin:<name> or script:<name>', async () => {
    expect(
      await sqlState(repo.append({ actor: 'someone' as Actor, action: 'x', entity: 'y' })),
    ).toBe('23514');
  });

  it('lists newest first, page by page', async () => {
    for (let i = 1; i <= 5; i++) {
      await repo.append({ actor: 'system', action: `page-${i}`, entity: 'test' });
    }
    const first = await repo.list({ limit: 3 });
    expect(first.map((r) => r.action)).toEqual(['page-5', 'page-4', 'page-3']);
    const next = await repo.list({ limit: 3, beforeId: first.at(-1)!.id });
    expect(next.map((r) => r.action)).toEqual(['page-2', 'page-1', 'submit:disable']);
  });
});
