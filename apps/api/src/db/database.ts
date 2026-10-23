/**
 * The API's access to PostgreSQL (doc 03 §5.1 DatabaseModule): one `pg` pool, connected as `m100_app`, and a
 * transaction helper. Repositories take a `Queryable`, so a caller can run several of them in one transaction.
 */
import { Logger } from '@nestjs/common';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

/**
 * A pool for `connectionString`. An idle client whose connection dies (the database was restarted or stopped)
 * emits `error` on the pool; it is logged instead of taking the process down, and the next query reconnects.
 */
export function createPool(connectionString: string, applicationName: string): Pool {
  const pool = new Pool({ connectionString, application_name: applicationName });
  pool.on('error', (error) =>
    new Logger('Database').warn(`Idle connection lost: ${error.message}`),
  );
  return pool;
}

/** Anything that runs a parameterised query: the `Database`, or the client of an open transaction. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
}

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export interface TransactionOptions {
  /** Default `READ COMMITTED`. Validation of a submission runs at `REPEATABLE READ` (doc 02 §6.1 step 2). */
  isolation?: IsolationLevel;
  readOnly?: boolean;
}

const ISOLATION: Readonly<Record<IsolationLevel, string>> = {
  'READ COMMITTED': 'READ COMMITTED',
  'REPEATABLE READ': 'REPEATABLE READ',
  SERIALIZABLE: 'SERIALIZABLE',
};

export class Database implements Queryable {
  constructor(readonly pool: Pool) {}

  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(sql, params);
  }

  /**
   * Runs `fn` in one transaction on one pooled client: committed when `fn` resolves, rolled back when it throws (the
   * error is passed on). The client goes back to the pool either way; a client whose rollback failed is discarded.
   */
  async transaction<T>(
    fn: (tx: Queryable) => Promise<T>,
    { isolation = 'READ COMMITTED', readOnly = false }: TransactionOptions = {},
  ): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query(
        `BEGIN ISOLATION LEVEL ${ISOLATION[isolation]} ${readOnly ? 'READ ONLY' : 'READ WRITE'}`,
      );
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch((rollbackError: Error) => {
          broken = rollbackError;
        });
        throw error;
      }
    } finally {
      client.release(broken);
    }
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}

/** The name of the database `q` is connected to, as the server reports it (not as a URL claims it). */
export async function currentDatabase(q: Queryable): Promise<string> {
  const { rows } = await q.query<{ name: string }>('SELECT current_database() AS name');
  return rows[0]!.name;
}

/** The SQLSTATE of an error from PostgreSQL, `undefined` for anything else (a network error has `ECONN…`). */
function sqlStateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** Errors `pg` raises itself when the connection is lost or cannot be made; they carry no code. */
const CONNECTION_MESSAGES =
  /Connection terminated|timeout exceeded when trying to connect|connection error|Client was closed/i;

/**
 * Whether `error` means the database cannot be reached right now (doc 03 §5.7: `503 DB_UNAVAILABLE`, retryable),
 * as opposed to a statement that failed (a constraint, a bug: `500 INTERNAL`). Unreachable: a socket error
 * (`ECONNREFUSED`, `ETIMEDOUT`, …), a connection `pg` lost or could not open in time, and the SQLSTATE classes
 * connection exception (08), insufficient resources (53) and operator intervention (57: shut down, restarting),
 * plus 55000 for a database that does not accept connections.
 */
export function isDbUnavailable(error: unknown): boolean {
  const state = sqlStateOf(error);
  if (state) return ['08', '53', '57'].includes(state.slice(0, 2)) || state === '55000';
  // Structural, not `instanceof Error`: socket errors may come from another realm (Jest's sandbox).
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return (
    (typeof code === 'string' && /^E[A-Z]+$/.test(code)) ||
    (typeof message === 'string' && CONNECTION_MESSAGES.test(message))
  );
}

/** A serialization failure or deadlock: the transaction may simply be run again (doc 03 §5.7). */
export function isRetryableTransactionError(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state === '40001' || state === '40P01';
}
