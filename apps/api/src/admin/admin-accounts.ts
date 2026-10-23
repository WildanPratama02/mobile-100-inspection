/**
 * Admin accounts (doc 02 §5.2, doc 05 §20.6): add, reset a password, deactivate, reactivate. Used by the CLI `admin:create`
 * (doc 03 §6, §7.4) and by the admin endpoints. Each change writes an `audit_log` row in its own transaction;
 * neither a password nor its hash ever goes into the audit log.
 */
import { type Database, currentDatabase } from '../db/database';
import {
  type Admin,
  type AdminRepository,
  PgAdminRepository,
} from '../repositories/admin.repository';
import {
  type Actor,
  type AuditLogRepository,
  PgAuditLogRepository,
} from '../repositories/audit-log.repository';
import { hashPassword, passwordProblem } from './passwords';

export interface AdminAccountRepositories {
  admins: AdminRepository;
  auditLog: AuditLogRepository;
}

export function pgAdminAccountRepositories(db: Database): AdminAccountRepositories {
  return { admins: new PgAdminRepository(db), auditLog: new PgAuditLogRepository(db) };
}

export type AdminAccountRefusal =
  | 'USERNAME_INVALID'
  | 'USERNAME_TAKEN'
  | 'PASSWORD_WEAK'
  | 'NOT_FOUND'
  | 'SELF'
  | 'LAST_ACTIVE_ADMIN'
  | 'DEV_DEFAULT_REFUSED';

/** A change refused before anything was written. */
export class AdminAccountError extends Error {
  constructor(
    readonly reason: AdminAccountRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'AdminAccountError';
  }
}

const MAX_USERNAME = 64;

/** Why `username` cannot name an admin, or `null`. */
export function usernameProblem(username: string): string | null {
  if (username.length === 0 || username.trim() !== username) {
    return 'Username is empty or has spaces at either end';
  }
  if (username.length > MAX_USERNAME) return `Username is longer than ${MAX_USERNAME} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(username)) return 'Username contains a control character';
  return null;
}

/** Adds an active admin with `password` (≥ 10 characters). */
export async function createAdmin(
  db: Database,
  repos: AdminAccountRepositories,
  { username, password, actor }: { username: string; password: string; actor: Actor },
): Promise<Admin> {
  checkUsername(username);
  checkPassword(password);
  return insertAdmin(db, repos, username, await hashPassword(password), actor);
}

/** Gives the admin `username` a new password (≥ 10 characters); clears a lock. Does not reactivate. */
export async function resetAdminPassword(
  db: Database,
  repos: AdminAccountRepositories,
  { username, password, actor }: { username: string; password: string; actor: Actor },
): Promise<Admin> {
  checkPassword(password);
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const admin = await repos.admins.findByUsername(username, tx);
    if (!admin) throw new AdminAccountError('NOT_FOUND', `No admin has the username "${username}"`);
    await repos.admins.setPassword(admin.id, passwordHash, tx);
    await repos.auditLog.append(
      {
        actor,
        action: 'reset_password',
        entity: 'admins',
        entityId: String(admin.id),
        details: { username, active: admin.active },
      },
      tx,
    );
    return (await repos.admins.findById(admin.id, tx))!;
  });
}

/**
 * Deactivates the admin `id`. Refused for the admin acting (`actorId`) and for the last active admin (doc 05
 * §20.6); the active rows stay locked until the end, so two parallel deactivations cannot leave none. An admin who
 * is already inactive is returned unchanged.
 */
export async function deactivateAdmin(
  db: Database,
  repos: AdminAccountRepositories,
  { id, actor, actorId }: { id: number; actor: Actor; actorId?: number },
): Promise<Admin> {
  return db.transaction(async (tx) => {
    const active = await repos.admins.lockActive(tx);
    const admin = await repos.admins.findById(id, tx);
    if (!admin) throw new AdminAccountError('NOT_FOUND', `No admin has the id ${id}`);
    if (!admin.active) return admin;
    if (id === actorId) {
      throw new AdminAccountError('SELF', 'An admin cannot deactivate their own account');
    }
    if (active.length <= 1) {
      throw new AdminAccountError(
        'LAST_ACTIVE_ADMIN',
        'The last active admin cannot be deactivated',
      );
    }
    await repos.admins.setActive(id, false, tx);
    await repos.auditLog.append(
      {
        actor,
        action: 'deactivate',
        entity: 'admins',
        entityId: String(id),
        details: { username: admin.username, old: { active: true }, new: { active: false } },
      },
      tx,
    );
    return (await repos.admins.findById(id, tx))!;
  });
}

/** Reactivates the admin `id` (doc 04 §10 A15). An admin who is already active is returned unchanged. */
export async function reactivateAdmin(
  db: Database,
  repos: AdminAccountRepositories,
  { id, actor }: { id: number; actor: Actor },
): Promise<Admin> {
  return db.transaction(async (tx) => {
    const admin = await repos.admins.findById(id, tx);
    if (!admin) throw new AdminAccountError('NOT_FOUND', `No admin has the id ${id}`);
    if (admin.active) return admin;
    await repos.admins.setActive(id, true, tx);
    await repos.auditLog.append(
      {
        actor,
        action: 'reactivate',
        entity: 'admins',
        entityId: String(id),
        details: { username: admin.username, old: { active: false }, new: { active: true } },
      },
      tx,
    );
    return (await repos.admins.findById(id, tx))!;
  });
}

/**
 * The development-only default admin (decided 23 Oct 2026): `admin` / `admin123`, below the 10-character rule,
 * so it may exist only in a development or test database. Never created by the API itself.
 */
export const DEV_DEFAULT_ADMIN = { username: 'admin', password: 'admin123' } as const;

const DEV_NODE_ENVS: readonly string[] = ['development', 'test'];
const DEV_DATABASE = /^(m100_dev|m100_test_[a-z0-9_]+)$/;

/**
 * Why the development default admin may not be created, or `null`. Fails closed: `NODE_ENV` must say
 * `development` or `test` (unset, `production` or anything else refuses), and the database the connection
 * actually reached must be `m100_dev` or `m100_test_…`.
 */
export function devDefaultRefusal(nodeEnv: string | undefined, database?: string): string | null {
  if (nodeEnv === undefined || !DEV_NODE_ENVS.includes(nodeEnv)) {
    return `NODE_ENV is ${nodeEnv === undefined ? 'not set' : `"${nodeEnv}"`}; the development default admin needs NODE_ENV=development or test`;
  }
  if (database !== undefined && !DEV_DATABASE.test(database)) {
    return `Database "${database}" is not m100_dev or m100_test_*; the development default admin is refused`;
  }
  return null;
}

/**
 * Creates `admin` / `admin123` after both checks of `devDefaultRefusal`: `NODE_ENV` before connecting, the
 * database name inside the transaction that writes. An existing `admin` is left as it is (`created: false`).
 */
export async function createDevDefaultAdmin(
  db: Database,
  repos: AdminAccountRepositories,
  { nodeEnv }: { nodeEnv: string | undefined },
): Promise<{ created: boolean; database: string }> {
  const early = devDefaultRefusal(nodeEnv);
  if (early) throw new AdminAccountError('DEV_DEFAULT_REFUSED', early);
  const { username, password } = DEV_DEFAULT_ADMIN;
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const database = await currentDatabase(tx);
    const refused = devDefaultRefusal(nodeEnv, database);
    if (refused) throw new AdminAccountError('DEV_DEFAULT_REFUSED', refused);
    if (await repos.admins.findByUsername(username, tx)) return { created: false, database };
    const admin = await repos.admins.insert(username, passwordHash, tx);
    await repos.auditLog.append(
      {
        actor: 'script:admin:create',
        action: 'create',
        entity: 'admins',
        entityId: String(admin.id),
        details: { username, devDefault: true, database },
      },
      tx,
    );
    return { created: true, database };
  });
}

async function insertAdmin(
  db: Database,
  repos: AdminAccountRepositories,
  username: string,
  passwordHash: string,
  actor: Actor,
): Promise<Admin> {
  try {
    return await db.transaction(async (tx) => {
      if (await repos.admins.findByUsername(username, tx)) throw taken(username);
      const admin = await repos.admins.insert(username, passwordHash, tx);
      await repos.auditLog.append(
        {
          actor,
          action: 'create',
          entity: 'admins',
          entityId: String(admin.id),
          details: { username },
        },
        tx,
      );
      return admin;
    });
  } catch (error) {
    // Another `admin:create` took the username between the check and the insert.
    if ((error as { code?: string }).code === '23505') throw taken(username);
    throw error;
  }
}

function checkUsername(username: string): void {
  const problem = usernameProblem(username);
  if (problem) throw new AdminAccountError('USERNAME_INVALID', problem);
}

function checkPassword(password: string): void {
  const problem = passwordProblem(password);
  if (problem) throw new AdminAccountError('PASSWORD_WEAK', problem);
}

function taken(username: string): AdminAccountError {
  return new AdminAccountError(
    'USERNAME_TAKEN',
    `An admin with the username "${username}" already exists; use --reset to set a new password`,
  );
}
