import { createHash } from 'node:crypto';
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import type { AuthRequest } from '../auth/auth.decorator';
import { ApiProblem } from '../errors/problem';

/** 60 requests per minute per device (doc 03 §5.6, doc 04 §7). */
export const RATE_LIMIT = { ttl: 60_000, limit: 60 } as const;

/**
 * Counts requests per device across all routes. Runs after `DeviceKeyGuard`, so a device is its id; on routes
 * without the device guard (`/health`) it is the SHA-256 of an `X-Device-Key` header, and a request without one
 * counts against its IP. Over the limit the answer is `429 RATE_LIMITED` with `Retry-After`.
 */
@Injectable()
export class DeviceThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: AuthRequest): Promise<string> {
    if (req.device) return Promise.resolve(`device:${req.device.id}`);
    const key = req.headers['x-device-key'];
    if (typeof key === 'string' && key.length > 0) {
      return Promise.resolve(`device:${createHash('sha256').update(key).digest('hex')}`);
    }
    return Promise.resolve(`ip:${req.ip ?? 'unknown'}`);
  }

  /** One budget per device, not per route as the library default would give. */
  protected override generateKey(
    _context: ExecutionContext,
    tracker: string,
    name: string,
  ): string {
    return `${name}:${tracker}`;
  }

  protected override throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw new ApiProblem('RATE_LIMITED', { retryAfter: Math.max(1, detail.timeToBlockExpire) });
  }
}
