/**
 * Admin accounts and the audit log in the admin app (doc 04 §8, doc 05 §20.6, FR-14.6–14.7). Accounts: list, add,
 * reset a password, deactivate (never yourself, never the last active admin) and reactivate (doc 04 §10 A15); each
 * change goes through `admin-accounts.ts` and writes its `audit_log` row. The audit log is read only.
 */
import { Inject, Injectable } from '@nestjs/common';
import { toWibIso } from '@m100/shared';
import { z } from 'zod';
import type { AdminPrincipal } from '../../auth/auth.decorator';
import { Database } from '../../db/database';
import { ApiProblem } from '../../errors/problem';
import {
  ADMIN_REPOSITORY,
  type Admin,
  type AdminRepository,
} from '../../repositories/admin.repository';
import {
  AUDIT_LOG_REPOSITORY,
  type Actor,
  type AuditLogRepository,
} from '../../repositories/audit-log.repository';
import {
  AdminAccountError,
  type AdminAccountRepositories,
  createAdmin,
  deactivateAdmin,
  reactivateAdmin,
  resetAdminPassword,
} from '../admin-accounts';
import { AdminDb } from '../admin-db';
import {
  isoDate,
  optionalQuery,
  pageQuery,
  parse,
  RANGE_ERROR,
  rangeInOrder,
} from '../admin-input';
import { MAX_PASSWORD_LENGTH, passwordProblem } from '../passwords';

/** Doc 05 §20.6 shows the log as a table; 50 rows a page, like the submissions. */
export const AUDIT_PAGE_SIZE = 50;

const NOT_FOUND_DETAIL = 'Admin tidak ditemukan.';

const username = z
  .string()
  .min(1)
  .max(64)
  .refine((s) => s.trim() === s, { message: 'Tidak boleh diawali atau diakhiri spasi.' })
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), { message: 'Berisi karakter kontrol.' });
// The length rule is checked after parsing, so its answer carries `PASSWORD_TOO_SHORT` like `/admin/me/password`.
const password = z.string().max(MAX_PASSWORD_LENGTH * 4);

// Unknown fields are refused (doc 03 §6). A change is either a new password or a new state, never both at once,
// so each answer stands for one audited change.
const schemas = {
  create: z.strictObject({ username, password }),
  patch: z.union([z.strictObject({ active: z.boolean() }), z.strictObject({ password })]),
  auditQuery: z
    .object({
      from: optionalQuery(isoDate),
      to: optionalQuery(isoDate),
      actor: optionalQuery(z.string().max(100)),
      page: pageQuery,
    })
    .refine(rangeInOrder, RANGE_ERROR),
};

export interface AdminAccount {
  id: number;
  username: string;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Locked after 5 failed logins until the time shown (doc 04 §7). */
  lockedUntil: string | null;
}

export interface AuditLogPage {
  total: number;
  page: number;
  pageSize: number;
  items: {
    id: string;
    at: string;
    actor: string;
    action: string;
    entity: string;
    entityId: string | null;
    details: unknown;
  }[];
}

@Injectable()
export class AccountsAdminService {
  private readonly repos: AdminAccountRepositories;

  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(ADMIN_REPOSITORY) admins: AdminRepository,
    @Inject(AUDIT_LOG_REPOSITORY) private readonly auditLog: AuditLogRepository,
    @Inject(AdminDb) private readonly db: AdminDb,
  ) {
    this.repos = { admins, auditLog };
  }

  async admins(): Promise<AdminAccount[]> {
    return (await this.db.run(() => this.repos.admins.list())).map(accountOf);
  }

  async create(principal: AdminPrincipal, body: unknown): Promise<AdminAccount> {
    const input = parse(schemas.create, body);
    checkPassword(input.password);
    return accountOf(
      await this.change(() =>
        createAdmin(this.database, this.repos, { ...input, actor: actorOf(principal) }),
      ),
    );
  }

  async update(principal: AdminPrincipal, key: string, body: unknown): Promise<AdminAccount> {
    const id = intKey(key);
    const input = parse(schemas.patch, body);
    const actor = actorOf(principal);
    if ('password' in input) {
      checkPassword(input.password);
      const admin = await this.db.run(() => this.repos.admins.findById(id));
      if (!admin) throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
      return accountOf(
        await this.change(() =>
          resetAdminPassword(this.database, this.repos, {
            username: admin.username,
            password: input.password,
            actor,
          }),
        ),
      );
    }
    return accountOf(
      await this.change(() =>
        input.active
          ? reactivateAdmin(this.database, this.repos, { id, actor })
          : deactivateAdmin(this.database, this.repos, { id, actor, actorId: principal.id }),
      ),
    );
  }

  async auditLogPage(query: unknown): Promise<AuditLogPage> {
    const { page, ...filter } = parse(schemas.auditQuery, query);
    const { total, items } = await this.db.run(() =>
      this.auditLog.search(filter, {
        offset: (page - 1) * AUDIT_PAGE_SIZE,
        limit: AUDIT_PAGE_SIZE,
      }),
    );
    return {
      total,
      page,
      pageSize: AUDIT_PAGE_SIZE,
      items: items.map((r) => ({
        id: r.id,
        at: toWibIso(r.at),
        actor: r.actor,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        details: r.details,
      })),
    };
  }

  /** Runs an account change; its refusals become the problems of doc 04 §6. */
  private async change(fn: () => Promise<Admin>): Promise<Admin> {
    try {
      return await this.db.run(fn);
    } catch (error) {
      if (!(error instanceof AdminAccountError)) throw error;
      switch (error.reason) {
        case 'NOT_FOUND':
          throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
        case 'USERNAME_TAKEN':
          throw new ApiProblem('CONFLICT', { detail: 'Username ini sudah ada.' });
        case 'SELF':
          throw fieldProblem('active', 'SELF', 'Admin tidak dapat menonaktifkan akunnya sendiri.');
        case 'LAST_ACTIVE_ADMIN':
          throw fieldProblem(
            'active',
            'LAST_ACTIVE_ADMIN',
            'Admin aktif terakhir tidak dapat dinonaktifkan.',
          );
        default:
          throw fieldProblem('username', 'INVALID', error.message);
      }
    }
  }
}

function accountOf(admin: Admin): AdminAccount {
  const locked = admin.lockedUntil && admin.lockedUntil.getTime() > Date.now();
  return {
    id: admin.id,
    username: admin.username,
    active: admin.active,
    createdAt: toWibIso(admin.createdAt),
    lastLoginAt: admin.lastLoginAt ? toWibIso(admin.lastLoginAt) : null,
    lockedUntil: locked ? toWibIso(admin.lockedUntil!) : null,
  };
}

const actorOf = (principal: AdminPrincipal): Actor => `admin:${principal.username}`;

function checkPassword(value: string): void {
  const weak = passwordProblem(value);
  if (weak) throw fieldProblem('password', 'PASSWORD_TOO_SHORT', weak);
}

function fieldProblem(path: string, code: string, message: string): ApiProblem {
  return new ApiProblem('VALIDATION_FAILED', {
    detail: message,
    errors: [{ path, code, message }],
  });
}

/** A numeric id from the path; anything else names no admin. */
function intKey(key: string): number {
  const n = /^[1-9][0-9]{0,9}$/.test(key) ? Number(key) : NaN;
  if (!Number.isSafeInteger(n) || n > 2_147_483_647) {
    throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
  }
  return n;
}
