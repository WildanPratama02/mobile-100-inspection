import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type AuthRequest, authLevel, isAdminLevel } from '../auth/auth.decorator';
import { ApiProblem } from '../errors/problem';
import { ADMIN_REPOSITORY, type AdminRepository } from '../repositories/admin.repository';
import { AdminDb } from './admin-db';
import { ADMIN_COOKIE, AdminTokens, cookieValue, REQUESTED_WITH } from './admin-session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The admin half of doc 04 §2 on `@Auth('admin-login')` and `@Auth('admin')` routes. A state-changing request
 * (login included) must carry `X-Requested-With: m100-admin`; an `admin` route also needs the `m100_admin` cookie
 * with a valid `aud` = `admin` token of an admin who is still active (looked up on every request, so a
 * deactivation ends the session at once). A tablet token is no admin session. Every refusal is
 * `401 ADMIN_AUTH_REQUIRED`; the admin goes to `req.admin`.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AdminTokens) private readonly tokens: AdminTokens,
    @Inject(ADMIN_REPOSITORY) private readonly admins: AdminRepository,
    @Inject(AdminDb) private readonly db: AdminDb,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const level = authLevel(this.reflector, context);
    if (!isAdminLevel(level)) return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (
      !SAFE_METHODS.has(req.method) &&
      req.headers[REQUESTED_WITH.header] !== REQUESTED_WITH.value
    ) {
      throw new ApiProblem('ADMIN_AUTH_REQUIRED', {
        detail: `Header X-Requested-With: ${REQUESTED_WITH.value} wajib.`,
      });
    }
    if (level === 'admin-login') return true;

    const token = cookieValue(req.headers.cookie, ADMIN_COOKIE);
    const claims = token ? this.tokens.verify(token) : null;
    if (!claims) throw new ApiProblem('ADMIN_AUTH_REQUIRED');
    const admin = await this.db.run(() => this.admins.findById(claims.aid));
    if (!admin?.active || admin.username !== claims.sub) {
      throw new ApiProblem('ADMIN_AUTH_REQUIRED');
    }
    req.admin = { id: admin.id, username: admin.username };
    return true;
  }
}
