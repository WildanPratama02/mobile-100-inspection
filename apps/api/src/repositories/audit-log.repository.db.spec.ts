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

describe('PgAuditLogRepository.search (doc 05 §20.6)', () => {
  beforeAll(async () => {
    // 23:59 WIB on 16 Oct, 00:00 and 23:59 WIB on 17 Oct.
    await db.client.query(
      `INSERT INTO audit_log (at, actor, action, entity, entity_id) VALUES
         ('2026-10-16T16:59:00Z', 'admin:ana', 'search-1', 'search', 'a'),
         ('2026-10-16T17:00:00Z', 'admin:budi', 'search-2', 'search', 'b'),
         ('2026-10-17T16:59:00Z', 'admin:ana', 'search-3', 'search', 'a')`,
    );
  });
  const actions = async (filter: Parameters<PgAuditLogRepository['search']>[0], limit = 50) =>
    (await repo.search({ entity: 'search', ...filter }, { offset: 0, limit })).items.map(
      (r) => r.action,
    );

  it('filters on WIB days, both ends inclusive, newest first', async () => {
    expect(await actions({})).toEqual(['search-3', 'search-2', 'search-1']);
    expect(await actions({ from: '2026-10-17', to: '2026-10-17' })).toEqual([
      'search-3',
      'search-2',
    ]);
    expect(await actions({ to: '2026-10-16' })).toEqual(['search-1']);
  });

  it('orders by the numeric id, also past id 9 and 99 (not as text)', async () => {
    for (let i = 1; i <= 100; i++) {
      await repo.append({ actor: 'system', action: `order-${i}`, entity: 'order' });
    }
    const listed = (await repo.list({ limit: 200 }))
      .filter((r) => r.entity === 'order')
      .map((r) => r.action);
    const searched = (await repo.search({ entity: 'order' }, { offset: 0, limit: 200 })).items.map(
      (r) => r.action,
    );
    const expected = Array.from({ length: 100 }, (_, i) => `order-${100 - i}`);
    expect(listed).toEqual(expected);
    expect(searched).toEqual(expected);
  });

  it('filters on actor and entity id exactly, and counts every match', async () => {
    expect(await actions({ actor: 'admin:ana' })).toEqual(['search-3', 'search-1']);
    expect(await actions({ actor: 'admin:an' })).toEqual([]);
    expect(await actions({ entityId: 'b' })).toEqual(['search-2']);
    const page = await repo.search({ entity: 'search' }, { offset: 1, limit: 1 });
    expect(page.total).toBe(3);
    expect(page.items.map((r) => r.action)).toEqual(['search-2']);
  });
});
