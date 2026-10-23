import { createHash } from 'node:crypto';
import { type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { ADMIN_COOKIE, AdminTokens, cookieValue } from '../admin/admin-session';
import type { AuthRequest } from '../auth/auth.decorator';
import { ApiProblem } from '../errors/problem';

/** 60 requests per minute per device (doc 03 §5.6, doc 04 §7); admin calls count per client IP. */
export const RATE_LIMIT = { name: 'default', ttl: 60_000, limit: 60 } as const;

/**
 * 300 photo downloads per minute per client IP for a signed-in admin (doc 03 §5.6, owner decision 23 Oct 2026):
 * the A1b photo strip loads one request per photo. These requests do not count against `RATE_LIMIT`.
 */
export const ADMIN_PHOTO_RATE_LIMIT = { name: 'admin-photos', ttl: 60_000, limit: 300 } as const;

const ADMIN_PHOTO_ROUTE = 'm100:admin-photo-route';

/** Marks the admin photo download for `ADMIN_PHOTO_RATE_LIMIT`. */
export const AdminPhotoRateLimit = () => SetMetadata(ADMIN_PHOTO_ROUTE, true);

/**
 * Counts requests per device across all routes. Runs after `DeviceKeyGuard`, so a device is its id; on routes
 * without the device guard (`/health`) it is the SHA-256 of an `X-Device-Key` header, and a request without one
 * counts against its IP. Over the limit the answer is `429 RATE_LIMITED` with `Retry-After`.
 *
 * Each request counts in exactly one bucket: a request to the admin photo route that carries a validly signed
 * admin session cookie counts in `ADMIN_PHOTO_RATE_LIMIT`, every other request in `RATE_LIMIT`. Only the
 * signature is checked here; `AdminGuard`, which runs after this guard, still refuses (`401`) a session that is
 * missing, forged, expired or of a deactivated admin before any photo is read.
 */
@Injectable()
export class DeviceThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
    @Inject(AdminTokens) private readonly adminTokens: AdminTokens,
  ) {
    super(options, storage, reflector);
  }

  protected override getTracker(req: AuthRequest): Promise<string> {
    if (req.device) return Promise.resolve(`device:${req.device.id}`);
    const key = req.headers['x-device-key'];
    if (typeof key === 'string' && key.length > 0) {
      return Promise.resolve(`device:${createHash('sha256').update(key).digest('hex')}`);
    }
    return Promise.resolve(`ip:${req.ip ?? 'unknown'}`);
  }

  /** One budget per device (or per IP and bucket), not per route as the library default would give. */
  protected override generateKey(
    _context: ExecutionContext,
    tracker: string,
    name: string,
  ): string {
    return `${name}:${tracker}`;
  }

  /** Called once per configured bucket; only the request's own bucket counts it. */
  protected override handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const bucket = this.isAdminPhotoDownload(props.context)
      ? ADMIN_PHOTO_RATE_LIMIT.name
      : RATE_LIMIT.name;
    if (props.throttler.name !== bucket) return Promise.resolve(true);
    return super.handleRequest(props);
  }

  protected override throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw new ApiProblem('RATE_LIMITED', { retryAfter: Math.max(1, detail.timeToBlockExpire) });
  }

  private isAdminPhotoDownload(context: ExecutionContext): boolean {
    const photoRoute = this.reflector.getAllAndOverride<boolean | undefined>(ADMIN_PHOTO_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!photoRoute) return false;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = cookieValue(req.headers.cookie, ADMIN_COOKIE);
    return token !== null && this.adminTokens.verify(token) !== null;
  }
}
