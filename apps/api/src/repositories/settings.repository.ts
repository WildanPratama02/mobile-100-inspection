/**
 * `settings` (doc 02 §5.3): `master_version`, the `/master-data` ETag, incremented in the same transaction as any
 * master change (doc 02 §3); `submit_enabled`, the readiness check `SUBMIT_ENABLED` (doc 02 §10).
 */
import type { Database, Queryable } from '../db/database';

export const SETTINGS_REPOSITORY = Symbol('SettingsRepository');

export interface SettingsRepository {
  masterVersion(q?: Queryable): Promise<number>;
  /** Increments `master_version` and returns the new value. Pass the transaction of the master change. */
  bumpMasterVersion(q: Queryable): Promise<number>;
  submitEnabled(q?: Queryable): Promise<boolean>;
  setSubmitEnabled(enabled: boolean, q?: Queryable): Promise<void>;
}

export class PgSettingsRepository implements SettingsRepository {
  constructor(private readonly db: Database) {}

  async masterVersion(q: Queryable = this.db): Promise<number> {
    return Number(await this.read('master_version', q));
  }

  async bumpMasterVersion(q: Queryable): Promise<number> {
    // One statement, so two concurrent changes can never get the same version.
    const { rows } = await q.query<{ value: string }>(
      `UPDATE settings SET value = (value::bigint + 1)::text WHERE key = 'master_version' RETURNING value`,
    );
    return Number(required(rows[0], 'master_version').value);
  }

  async submitEnabled(q: Queryable = this.db): Promise<boolean> {
    return (await this.read('submit_enabled', q)) === 'true';
  }

  async setSubmitEnabled(enabled: boolean, q: Queryable = this.db): Promise<void> {
    const { rowCount } = await q.query(
      `UPDATE settings SET value = $1 WHERE key = 'submit_enabled'`,
      [String(enabled)],
    );
    if (rowCount !== 1) throw new Error('settings row submit_enabled is missing');
  }

  private async read(key: string, q: Queryable): Promise<string> {
    const { rows } = await q.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [
      key,
    ]);
    return required(rows[0], key).value;
  }
}

function required<T>(row: T | undefined, key: string): T {
  // Both rows are inserted by migration 0002; a missing one means a broken database, not a user error.
  if (!row) throw new Error(`settings row ${key} is missing`);
  return row;
}
