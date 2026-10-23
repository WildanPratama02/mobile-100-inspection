/**
 * `admins` (doc 02 §5.3): admin app accounts with argon2id password hashes. The lockout rule (5 failures lock the
 * account 10 minutes, doc 04 §2) belongs to the admin login (T3b.1); this repository only keeps the counters.
 */
import type { Database, Queryable } from '../db/database';

export const ADMIN_REPOSITORY = Symbol('AdminRepository');

export interface Admin {
  id: number;
  username: string;
  passwordHash: string;
  active: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  failedLogins: number;
  lockedUntil: Date | null;
}

export interface AdminRepository {
  findByUsername(username: string, q?: Queryable): Promise<Admin | null>;
  findById(id: number, q?: Queryable): Promise<Admin | null>;
  /** Fails with SQLSTATE `23505` when the username is taken. */
  insert(username: string, passwordHash: string, q?: Queryable): Promise<Admin>;
  /** `false` when no admin has this id. A new password also clears the failure counter and the lock. */
  setPassword(id: number, passwordHash: string, q?: Queryable): Promise<boolean>;
  setActive(id: number, active: boolean, q?: Queryable): Promise<boolean>;
  countActive(q?: Queryable): Promise<number>;
  /**
   * The ids of the active admins, each row locked until the transaction `q` ends (`FOR UPDATE`), so two
   * transactions that each deactivate an admin cannot both count the other one as still active.
   */
  lockActive(q: Queryable): Promise<number[]>;
  /** Adds one failed login and returns the new count; one statement, so parallel failures are all counted. */
  recordLoginFailure(id: number, q?: Queryable): Promise<number>;
  /** Locks the account and restarts the failure count, so the lock ends with a fresh set of attempts. */
  lockUntil(id: number, until: Date, q?: Queryable): Promise<void>;
  /** Clears the failure counter and the lock and sets `last_login_at`. */
  recordLoginSuccess(id: number, q?: Queryable): Promise<void>;
}

const COLUMNS = `id, username, password_hash AS "passwordHash", active, created_at AS "createdAt",
                 last_login_at AS "lastLoginAt", failed_logins AS "failedLogins", locked_until AS "lockedUntil"`;

export class PgAdminRepository implements AdminRepository {
  constructor(private readonly db: Database) {}

  async findByUsername(username: string, q: Queryable = this.db): Promise<Admin | null> {
    const { rows } = await q.query<Admin>(`SELECT ${COLUMNS} FROM admins WHERE username = $1`, [
      username,
    ]);
    return rows[0] ?? null;
  }

  async findById(id: number, q: Queryable = this.db): Promise<Admin | null> {
    const { rows } = await q.query<Admin>(`SELECT ${COLUMNS} FROM admins WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async insert(username: string, passwordHash: string, q: Queryable = this.db): Promise<Admin> {
    const { rows } = await q.query<Admin>(
      `INSERT INTO admins (username, password_hash) VALUES ($1, $2) RETURNING ${COLUMNS}`,
      [username, passwordHash],
    );
    return rows[0]!;
  }

  async setPassword(id: number, passwordHash: string, q: Queryable = this.db): Promise<boolean> {
    const { rowCount } = await q.query(
      `UPDATE admins SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1`,
      [id, passwordHash],
    );
    return rowCount === 1;
  }

  async setActive(id: number, active: boolean, q: Queryable = this.db): Promise<boolean> {
    const { rowCount } = await q.query(`UPDATE admins SET active = $2 WHERE id = $1`, [id, active]);
    return rowCount === 1;
  }

  async countActive(q: Queryable = this.db): Promise<number> {
    const { rows } = await q.query<{ n: number }>(
      `SELECT count(*)::integer AS n FROM admins WHERE active`,
    );
    return rows[0]!.n;
  }

  async lockActive(q: Queryable): Promise<number[]> {
    const { rows } = await q.query<{ id: number }>(
      `SELECT id FROM admins WHERE active ORDER BY id FOR UPDATE`,
    );
    return rows.map((row) => row.id);
  }

  async recordLoginFailure(id: number, q: Queryable = this.db): Promise<number> {
    const { rows } = await q.query<{ failedLogins: number }>(
      `UPDATE admins SET failed_logins = failed_logins + 1 WHERE id = $1
       RETURNING failed_logins AS "failedLogins"`,
      [id],
    );
    if (!rows[0]) throw new Error(`No admin with id ${id}`);
    return rows[0].failedLogins;
  }

  async lockUntil(id: number, until: Date, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE admins SET locked_until = $2, failed_logins = 0 WHERE id = $1`, [
      id,
      until,
    ]);
  }

  async recordLoginSuccess(id: number, q: Queryable = this.db): Promise<void> {
    await q.query(
      `UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [id],
    );
  }
}
