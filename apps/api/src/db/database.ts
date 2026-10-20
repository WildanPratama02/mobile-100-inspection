/**
 * The API's access to PostgreSQL (doc 03 §5.1 DatabaseModule): one `pg` pool, connected as `m100_app`, and a
 * transaction helper. Repositories take a `Queryable`, so a caller can run several of them in one transaction.
 */
import type { Pool, QueryResult, QueryResultRow } from 'pg';

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
