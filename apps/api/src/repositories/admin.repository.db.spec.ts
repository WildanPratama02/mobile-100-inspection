import { Database } from '../db/database';
import { createTestDatabase, sqlState, type TestDatabase } from '../testing/database';
import { PgAdminRepository } from './admin.repository';

let db: TestDatabase;
let repo: PgAdminRepository;

/** Not a real argon2id hash; the repository stores whatever it is given. */
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  repo = new PgAdminRepository(new Database(db.pool('m100_app')));
});
afterAll(async () => {
  await db?.drop();
});

describe('PgAdminRepository (doc 02 §5.3)', () => {
  let id: number;

  it('adds an admin and finds it by username', async () => {
    const admin = await repo.insert('qip.digital', HASH);
    id = admin.id;
    expect(admin).toMatchObject({
      username: 'qip.digital',
      passwordHash: HASH,
      active: true,
      lastLoginAt: null,
      failedLogins: 0,
      lockedUntil: null,
    });
    expect((await repo.findByUsername('qip.digital'))?.id).toBe(id);
    expect(await repo.findByUsername('nobody')).toBeNull();
    expect(await sqlState(repo.insert('qip.digital', HASH))).toBe('23505');
  });

  it('counts every concurrent failed login', async () => {
    const counts = await Promise.all(Array.from({ length: 5 }, () => repo.recordLoginFailure(id)));
    expect([...counts].sort()).toEqual([1, 2, 3, 4, 5]);
    expect((await repo.findByUsername('qip.digital'))?.failedLogins).toBe(5);
  });

  it('locks until a time, and a successful login clears the counter and the lock', async () => {
    const until = new Date(Date.now() + 10 * 60_000);
    await repo.lockUntil(id, until);
    expect((await repo.findByUsername('qip.digital'))?.lockedUntil).toEqual(until);

    await repo.recordLoginSuccess(id);
    const admin = await repo.findByUsername('qip.digital');
    expect(admin).toMatchObject({ failedLogins: 0, lockedUntil: null });
    expect(admin?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('changes the password hash', async () => {
    expect(await repo.setPassword(id, `${HASH}2`)).toBe(true);
    expect((await repo.findByUsername('qip.digital'))?.passwordHash).toBe(`${HASH}2`);
    expect(await repo.setPassword(99_999, HASH)).toBe(false);
  });

  it('deactivates and counts the active admins', async () => {
    await repo.insert('second', HASH);
    expect(await repo.countActive()).toBe(2);
    expect(await repo.setActive(id, false)).toBe(true);
    expect(await repo.countActive()).toBe(1);
    expect((await repo.findByUsername('qip.digital'))?.active).toBe(false);
  });

  it('fails a failed-login count for an unknown admin', async () => {
    await expect(repo.recordLoginFailure(99_999)).rejects.toThrow('No admin with id 99999');
  });
});
