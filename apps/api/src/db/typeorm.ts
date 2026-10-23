/**
 * The TypeORM side of `DatabaseModule` (doc 03 §5.1): a `DataSource` for the admin CRUD entities only, connected
 * as `m100_app` with `DATABASE_URL`. It never touches the schema (no `synchronize`, no migrations, no extensions).
 * It is opened on first use, not at start, so the API starts and serves tablets while the database is down; a
 * failed opening is forgotten and tried again by the next admin request.
 */
import type { QueryResult, QueryResultRow } from 'pg';
import { DataSource, type EntityManager } from 'typeorm';
import type { Queryable } from './database';
import { ADMIN_ENTITIES } from './entities';

export class AdminDataSource {
  private opening: Promise<DataSource> | undefined;

  constructor(private readonly url: string) {}

  /** The open `DataSource`. */
  async get(): Promise<DataSource> {
    this.opening ??= this.open();
    try {
      return await this.opening;
    } catch (error) {
      this.opening = undefined;
      throw error;
    }
  }

  /** Runs `fn` in one READ COMMITTED transaction: committed when it resolves, rolled back when it throws. */
  async transaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return (await this.get()).transaction('READ COMMITTED', fn);
  }

  async destroy(): Promise<void> {
    const opening = this.opening;
    this.opening = undefined;
    const source = await opening?.catch(() => undefined);
    if (source?.isInitialized) await source.destroy();
  }

  private async open(): Promise<DataSource> {
    // A new DataSource per attempt: one whose opening failed is not reused.
    const source = new DataSource({
      type: 'postgres',
      url: this.url,
      applicationName: 'm100 api admin',
      // Admin traffic is a handful of people; the tablets use the pg pool.
      poolSize: 4,
      entities: ADMIN_ENTITIES,
      synchronize: false,
      migrationsRun: false,
      installExtensions: false,
      logging: false,
    });
    return source.initialize();
  }
}

/**
 * The open transaction of `manager` as a `Queryable`, so the `pg` repositories (`audit_log`, `settings`) write in
 * the same transaction as the entity change they record.
 */
export function queryableOf(manager: EntityManager): Queryable {
  const runner = manager.queryRunner;
  if (!runner) throw new Error('queryableOf needs the manager of a transaction');
  return {
    async query<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<R>> {
      const result = await runner.query(sql, params, true);
      const rows = result.records as R[];
      return {
        rows,
        rowCount: result.affected ?? rows.length,
        command: '',
        oid: 0,
        fields: [],
      };
    },
  };
}
