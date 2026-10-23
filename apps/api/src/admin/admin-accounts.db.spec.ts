import { Database } from '../db/database';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import {
  AdminAccountError,
  type AdminAccountRefusal,
  createAdmin,
  createDevDefaultAdmin,
  deactivateAdmin,
  DEV_DEFAULT_ADMIN,
  devDefaultRefusal,
  pgAdminAccountRepositories,
  resetAdminPassword,
} from './admin-accounts';
import { verifyPassword } from './passwords';

let testDb: TestDatabase;
let db: Database;
const repos = () => pgAdminAccountRepositories(db);
const actor = 'script:admin:create' as const;
const STRONG = 'a-strong-password-1';

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  db = new Database(testDb.pool('m100_app'));
});
afterAll(async () => {
  await testDb?.drop();
});

async function refusal(promise: Promise<unknown>): Promise<AdminAccountRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AdminAccountError) return error.reason;
    throw error;
  }
  throw new Error('Expected the change to be refused, but it was made');
}

/** Every row of `admins` and `audit_log`, to show a refused change wrote nothing. */
async function snapshot(q: { query: Database['query'] } = testDb.client): Promise<unknown> {
  const admins = await q.query('SELECT * FROM admins ORDER BY id');
  const audit = await q.query('SELECT * FROM audit_log ORDER BY id');
  return { admins: admins.rows, audit: audit.rows };
}

async function auditOf(entityId: number) {
  const { rows } = await testDb.client.query<{
    actor: string;
    action: string;
    entity: string;
    details: Record<string, unknown> | null;
  }>(`SELECT actor, action, entity, details FROM audit_log WHERE entity_id = $1 ORDER BY id`, [
    String(entityId),
  ]);
  return rows;
}

describe('createAdmin', () => {
  it('adds an active admin with an argon2id hash and audits it without the password', async () => {
    const admin = await createAdmin(db, repos(), {
      username: 'qip.digital',
      password: STRONG,
      actor,
    });
    expect(admin).toMatchObject({ username: 'qip.digital', active: true });
    expect(admin.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(admin.passwordHash, STRONG)).toBe(true);
    const audit = await auditOf(admin.id);
    expect(audit).toEqual([
      { actor, action: 'create', entity: 'admins', details: { username: 'qip.digital' } },
    ]);
    expect(JSON.stringify(audit)).not.toContain(STRONG);
    expect(JSON.stringify(audit)).not.toContain('argon2');
  });

  it('refuses a password under 10 characters (admin123 too), a taken or blank username; writes nothing', async () => {
    const before = await snapshot();
    for (const password of ['admin123', '123456789']) {
      expect(
        await refusal(createAdmin(db, repos(), { username: 'new.one', password, actor })),
      ).toBe('PASSWORD_WEAK');
    }
    expect(
      await refusal(createAdmin(db, repos(), { username: 'qip.digital', password: STRONG, actor })),
    ).toBe('USERNAME_TAKEN');
    for (const username of ['', ' padded', 'x'.repeat(65), 'tab\there']) {
      expect(await refusal(createAdmin(db, repos(), { username, password: STRONG, actor }))).toBe(
        'USERNAME_INVALID',
      );
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe('resetAdminPassword', () => {
  it('sets a new password, clears a lock and audits it', async () => {
    const admin = (await repos().admins.findByUsername('qip.digital'))!;
    await repos().admins.recordLoginFailure(admin.id);
    await repos().admins.lockUntil(admin.id, new Date(Date.now() + 600_000));
    const reset = await resetAdminPassword(db, repos(), {
      username: 'qip.digital',
      password: 'another-password-2',
      actor,
    });
    expect(reset).toMatchObject({ failedLogins: 0, lockedUntil: null });
    expect(await verifyPassword(reset.passwordHash, 'another-password-2')).toBe(true);
    expect((await auditOf(admin.id)).at(-1)).toEqual({
      actor,
      action: 'reset_password',
      entity: 'admins',
      details: { username: 'qip.digital', active: true },
    });
  });

  it('refuses a weak password or an unknown admin; writes nothing', async () => {
    const before = await snapshot();
    expect(
      await refusal(
        resetAdminPassword(db, repos(), { username: 'qip.digital', password: 'short', actor }),
      ),
    ).toBe('PASSWORD_WEAK');
    expect(
      await refusal(
        resetAdminPassword(db, repos(), { username: 'nobody', password: STRONG, actor }),
      ),
    ).toBe('NOT_FOUND');
    expect(await snapshot()).toEqual(before);
  });
});

describe('deactivateAdmin (doc 05 §20.6)', () => {
  it('refuses the last active admin and the acting admin; writes nothing', async () => {
    const only = (await repos().admins.findByUsername('qip.digital'))!;
    const before = await snapshot();
    expect(await refusal(deactivateAdmin(db, repos(), { id: only.id, actor }))).toBe(
      'LAST_ACTIVE_ADMIN',
    );
    const second = await createAdmin(db, repos(), {
      username: 'second',
      password: STRONG,
      actor,
    });
    const afterCreate = await snapshot();
    expect(
      await refusal(
        deactivateAdmin(db, repos(), { id: only.id, actor: 'admin:qip.digital', actorId: only.id }),
      ),
    ).toBe('SELF');
    expect(await refusal(deactivateAdmin(db, repos(), { id: 99_999, actor }))).toBe('NOT_FOUND');
    expect(await snapshot()).toEqual(afterCreate);
    expect(before).not.toEqual(afterCreate);

    const done = await deactivateAdmin(db, repos(), {
      id: second.id,
      actor: 'admin:qip.digital',
      actorId: only.id,
    });
    expect(done.active).toBe(false);
    expect((await auditOf(second.id)).at(-1)).toEqual({
      actor: 'admin:qip.digital',
      action: 'deactivate',
      entity: 'admins',
      details: { username: 'second', old: { active: true }, new: { active: false } },
    });
    expect(await repos().admins.countActive()).toBe(1);
  });

  it('never leaves no active admin when two admins deactivate each other at once', async () => {
    const a = await createAdmin(db, repos(), { username: 'race.a', password: STRONG, actor });
    // qip.digital and race.a are active now; race.a and qip.digital each deactivate the other.
    const qip = (await repos().admins.findByUsername('qip.digital'))!;
    const results = await Promise.allSettled([
      deactivateAdmin(db, repos(), { id: qip.id, actor: 'admin:race.a', actorId: a.id }),
      deactivateAdmin(db, repos(), { id: a.id, actor: 'admin:qip.digital', actorId: qip.id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected?.reason as AdminAccountError).reason).toBe('LAST_ACTIVE_ADMIN');
    expect(await repos().admins.countActive()).toBe(1);
  });
});

describe('development default admin (decision B, 23 Oct 2026)', () => {
  it('fails closed on NODE_ENV and on the database name', () => {
    expect(devDefaultRefusal('development')).toBeNull();
    expect(devDefaultRefusal('test', 'm100_dev')).toBeNull();
    expect(devDefaultRefusal('test', 'm100_test_123_ab12')).toBeNull();
    for (const env of [
      undefined,
      '',
      'production',
      'Production',
      'prod',
      'staging',
      ' development',
    ]) {
      expect(devDefaultRefusal(env, 'm100_dev')).toMatch(/NODE_ENV/);
    }
    for (const name of [
      'm100',
      'm100_dev2',
      'm100_dev_copy',
      'm100_test',
      'm100_testing',
      'M100_DEV',
      'postgres',
      'm100_prod',
    ]) {
      expect(devDefaultRefusal('development', name)).toMatch(/is not m100_dev or m100_test_\*/);
    }
  });

  it.each([['production'], [undefined], ['staging']])(
    'refuses NODE_ENV=%s and writes nothing',
    async (nodeEnv) => {
      const before = await snapshot();
      expect(await refusal(createDevDefaultAdmin(db, repos(), { nodeEnv }))).toBe(
        'DEV_DEFAULT_REFUSED',
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it('refuses a database outside m100_dev / m100_test_* and writes nothing there', async () => {
    const other = await createTestDatabase({ migrated: true, prefix: 'm100_scratch' });
    try {
      const otherDb = new Database(other.pool('m100_app'));
      const before = await snapshot(other.client);
      const error = await createDevDefaultAdmin(otherDb, pgAdminAccountRepositories(otherDb), {
        nodeEnv: 'development',
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdminAccountError);
      expect((error as AdminAccountError).message).toContain(`Database "${other.name}"`);
      expect(await snapshot(other.client)).toEqual(before);
    } finally {
      await other.drop();
    }
  });

  it('creates admin / admin123 in a test database once, audited without the password', async () => {
    const first = await createDevDefaultAdmin(db, repos(), { nodeEnv: 'test' });
    expect(first).toEqual({ created: true, database: testDb.name });
    const admin = (await repos().admins.findByUsername(DEV_DEFAULT_ADMIN.username))!;
    expect(admin.active).toBe(true);
    expect(await verifyPassword(admin.passwordHash, 'admin123')).toBe(true);
    const audit = await auditOf(admin.id);
    expect(audit).toEqual([
      {
        actor,
        action: 'create',
        entity: 'admins',
        details: { username: 'admin', devDefault: true, database: testDb.name },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain('admin123');

    const before = await snapshot();
    expect(await createDevDefaultAdmin(db, repos(), { nodeEnv: 'development' })).toEqual({
      created: false,
      database: testDb.name,
    });
    expect(await snapshot()).toEqual(before);
  });
});
