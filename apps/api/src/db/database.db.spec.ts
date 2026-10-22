import { createTestDatabase, sqlState, type TestDatabase } from '../testing/database';
import { Pool } from 'pg';
import { Database, isDbUnavailable, isRetryableTransactionError } from './database';

let db: TestDatabase;
let database: Database;

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  database = new Database(db.pool('m100_app'));
});
afterAll(async () => {
  await db?.drop();
});

const auditRows = async (action: string): Promise<number> =>
  (await database.query('SELECT 1 FROM audit_log WHERE action = $1', [action])).rowCount ?? 0;

describe('Database (doc 03 §5.1)', () => {
  it('runs as m100_app, like the API', async () => {
    const { rows } = await database.query<{ user: string }>('SELECT current_user AS "user"');
    expect(rows[0]!.user).toBe('m100_app');
  });

  it('commits the transaction when the function resolves', async () => {
    const result = await database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO audit_log (actor, action, entity) VALUES ('system', 'commit-test', 'test')`,
      );
      return 'done';
    });
    expect(result).toBe('done');
    expect(await auditRows('commit-test')).toBe(1);
  });

  it('rolls back and passes the error on when the function throws', async () => {
    const failure = new Error('boom');
    await expect(
      database.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO audit_log (actor, action, entity) VALUES ('system', 'rollback-test', 'test')`,
        );
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await auditRows('rollback-test')).toBe(0);
  });

  it('applies the isolation level and read-only mode', async () => {
    const settings = await database.transaction(
      async (tx) =>
        (
          await tx.query<{ isolation: string; readOnly: string }>(
            `SELECT current_setting('transaction_isolation') AS isolation,
                    current_setting('transaction_read_only') AS "readOnly"`,
          )
        ).rows[0],
      { isolation: 'REPEATABLE READ', readOnly: true },
    );
    expect(settings).toEqual({ isolation: 'repeatable read', readOnly: 'on' });

    const READ_ONLY_TRANSACTION = '25006';
    expect(
      await sqlState(
        database.transaction(
          (tx) =>
            tx.query(
              `INSERT INTO audit_log (actor, action, entity) VALUES ('system', 'ro-test', 'test')`,
            ),
          { readOnly: true },
        ),
      ),
    ).toBe(READ_ONLY_TRANSACTION);
  });

  it('defaults to READ COMMITTED, read-write', async () => {
    const settings = await database.transaction(
      async (tx) =>
        (
          await tx.query(
            `SELECT current_setting('transaction_isolation') AS isolation,
                    current_setting('transaction_read_only') AS "readOnly"`,
          )
        ).rows[0],
    );
    expect(settings).toEqual({ isolation: 'read committed', readOnly: 'off' });
  });

  it('returns the client to the pool after failures, so the pool never runs dry', async () => {
    const pool = db.pool('m100_app');
    const small = new Database(pool);
    // More failing transactions than the pool's 10 clients: a leaked client would make this hang.
    for (let i = 0; i < 15; i++) {
      await expect(small.transaction((tx) => tx.query('SELECT 1/0'))).rejects.toThrow(
        'division by zero',
      );
    }
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
  });
});

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a failure');
}

describe('isDbUnavailable (doc 03 §5.7)', () => {
  it('is false for a statement that failed: a constraint, a bug, a privilege', async () => {
    for (const sql of ['SELECT 1/0', 'SELECT * FROM no_such_table', 'DELETE FROM submissions']) {
      expect(isDbUnavailable(await failure(database.query(sql)))).toBe(false);
    }
    expect(isDbUnavailable(new Error('PO 1 is not in pos'))).toBe(false);
    expect(isDbUnavailable(undefined)).toBe(false);
  });

  it('is true for a database that refuses or cuts connections', async () => {
    const cut = new Database(db.pool('m100_app'));
    await cut.query('SELECT 1');
    await db.allowConnections(false);
    try {
      expect(isDbUnavailable(await failure(cut.query('SELECT 1')))).toBe(true);
      expect(isDbUnavailable(await failure(cut.transaction((tx) => tx.query('SELECT 1'))))).toBe(
        true,
      );
    } finally {
      await db.allowConnections(true);
    }
  });

  it('is true when nothing listens on the port', async () => {
    const url = new URL(db.url('m100_app'));
    url.port = '1';
    const nobody = new Pool({ connectionString: url.href });
    try {
      expect(isDbUnavailable(await failure(nobody.query('SELECT 1')))).toBe(true);
    } finally {
      await nobody.end();
    }
  });
});

describe('isRetryableTransactionError', () => {
  it('is true for a serialization failure and a deadlock only', () => {
    expect(isRetryableTransactionError({ code: '40001' })).toBe(true);
    expect(isRetryableTransactionError({ code: '40P01' })).toBe(true);
    expect(isRetryableTransactionError({ code: '23505' })).toBe(false);
    expect(isRetryableTransactionError(new Error('x'))).toBe(false);
  });
});
