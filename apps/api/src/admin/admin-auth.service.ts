import { Inject, Injectable } from '@nestjs/common';
import { toWibIso } from '@m100/shared';
import { z } from 'zod';
import type { AdminPrincipal } from '../auth/auth.decorator';
import { Database } from '../db/database';
import { ApiProblem } from '../errors/problem';
import { validationFailed } from '../errors/validation';
import {
  type Admin,
  ADMIN_REPOSITORY,
  type AdminRepository,
} from '../repositories/admin.repository';
import {
  AUDIT_LOG_REPOSITORY,
  type AuditLogRepository,
} from '../repositories/audit-log.repository';
import { AdminDb } from './admin-db';
import { AdminTokens } from './admin-session';
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  passwordProblem,
  verifyDummy,
  verifyPassword,
} from './passwords';

/** Doc 04 §2, §7: 5 failed logins lock the account for 10 minutes. */
export const LOGIN_LOCK = { failures: 5, ms: 10 * 60_000 } as const;

const password = z.string().min(1).max(MAX_PASSWORD_LENGTH);
// Unknown fields are refused (doc 03 §6).
const loginSchema = z.strictObject({ username: z.string().min(1).max(256), password });
const changePasswordSchema = z.strictObject({ currentPassword: password, newPassword: z.string() });

/** `GET /admin/me`. */
export interface AdminMe {
  username: string;
  lastLoginAt?: string;
}

/**
 * Admin login, `/admin/me` and the own password (doc 04 §8). A wrong password, an unknown username and an inactive
 * account get the same `401 ADMIN_LOGIN_FAILED` after the same argon2id work. The 5th failure in a row locks the
 * account for 10 minutes (`423 ADMIN_LOCKED`, also for the right password) and writes an `audit_log` row; a wrong
 * current password on a password change counts as a failure too.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(ADMIN_REPOSITORY) private readonly admins: AdminRepository,
    @Inject(AUDIT_LOG_REPOSITORY) private readonly auditLog: AuditLogRepository,
    @Inject(AdminTokens) private readonly tokens: AdminTokens,
    @Inject(AdminDb) private readonly db: AdminDb,
  ) {}

  /** The session token for the cookie. */
  async login(body: unknown): Promise<string> {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw validationFailed(parsed.error, body);
    const { username, password } = parsed.data;
    const admin = await this.db.run(() => this.admins.findByUsername(username));
    if (!admin?.active) {
      await verifyDummy(password);
      throw new ApiProblem('ADMIN_LOGIN_FAILED');
    }
    refuseWhileLocked(admin);
    if (!(await verifyPassword(admin.passwordHash, password))) {
      await this.countFailure(admin);
      throw new ApiProblem('ADMIN_LOGIN_FAILED');
    }
    await this.db.run(() =>
      this.database.transaction(async (tx) => {
        await this.admins.recordLoginSuccess(admin.id, tx);
        await this.auditLog.append(
          {
            actor: `admin:${admin.username}`,
            action: 'login',
            entity: 'admins',
            entityId: String(admin.id),
          },
          tx,
        );
      }),
    );
    return this.tokens.issue({ sub: admin.username, aid: admin.id }).token;
  }

  async me(principal: AdminPrincipal): Promise<AdminMe> {
    const admin = await this.db.run(() => this.admins.findById(principal.id));
    if (!admin) throw new ApiProblem('ADMIN_AUTH_REQUIRED');
    return {
      username: admin.username,
      ...(admin.lastLoginAt ? { lastLoginAt: toWibIso(admin.lastLoginAt) } : {}),
    };
  }

  /** The signed-in admin's own password: the current one, and a new one of at least 10 characters. */
  async changePassword(principal: AdminPrincipal, body: unknown): Promise<void> {
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success) throw validationFailed(parsed.error, body);
    const { currentPassword, newPassword } = parsed.data;
    const weak = passwordProblem(newPassword);
    if (weak) throw fieldProblem('newPassword', 'PASSWORD_TOO_SHORT', weak);

    const admin = await this.db.run(() => this.admins.findById(principal.id));
    if (!admin) throw new ApiProblem('ADMIN_AUTH_REQUIRED');
    refuseWhileLocked(admin);
    if (!(await verifyPassword(admin.passwordHash, currentPassword))) {
      await this.countFailure(admin);
      throw fieldProblem('currentPassword', 'PASSWORD_WRONG', 'Password lama salah.');
    }
    const passwordHash = await hashPassword(newPassword);
    await this.db.run(() =>
      this.database.transaction(async (tx) => {
        await this.admins.setPassword(admin.id, passwordHash, tx);
        await this.auditLog.append(
          {
            actor: `admin:${admin.username}`,
            action: 'change_password',
            entity: 'admins',
            entityId: String(admin.id),
            details: { username: admin.username },
          },
          tx,
        );
      }),
    );
  }

  /** Counts a failed attempt; the 5th locks the account (`423 ADMIN_LOCKED`) and is audited. */
  private async countFailure(admin: Admin): Promise<void> {
    const lockedUntil = await this.db.run(() =>
      this.database.transaction(async (tx) => {
        const failures = await this.admins.recordLoginFailure(admin.id, tx);
        if (failures < LOGIN_LOCK.failures) return null;
        const until = new Date(Date.now() + LOGIN_LOCK.ms);
        await this.admins.lockUntil(admin.id, until, tx);
        await this.auditLog.append(
          {
            actor: 'system',
            action: 'lock',
            entity: 'admins',
            entityId: String(admin.id),
            details: { username: admin.username, failures, lockedUntil: toWibIso(until) },
          },
          tx,
        );
        return until;
      }),
    );
    if (lockedUntil) throw locked(lockedUntil);
  }
}

function refuseWhileLocked(admin: Admin): void {
  if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now())
    throw locked(admin.lockedUntil);
}

function locked(until: Date): ApiProblem {
  return new ApiProblem('ADMIN_LOCKED', {
    retryAfter: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)),
  });
}

function fieldProblem(path: string, code: string, message: string): ApiProblem {
  return new ApiProblem('VALIDATION_FAILED', {
    detail: message,
    errors: [{ path, code, message }],
  });
}
