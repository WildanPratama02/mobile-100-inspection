import { timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiProblem } from '../errors/problem';
import { ReadinessService, RETRY_MS } from '../master-data/readiness.service';
import {
  type Device,
  DEVICE_REPOSITORY,
  type DeviceRepository,
} from '../repositories/device.repository';
import { type AuthRequest, authLevel, isAdminLevel } from './auth.decorator';
import { hashDeviceKey, isDeviceKeyShape } from './device-key';

/** Doc 03 §5.6: 20 failed key attempts per minute per IP; the next ones are refused until the minute is over. */
export const KEY_FAILURES = { limit: 20, windowMs: 60_000 } as const;
/** `devices.last_seen_at` is written at most this often per device, not on every request. */
const TOUCH_EVERY_MS = 60_000;

/**
 * `X-Device-Key` on every route but `@Auth('none')` (doc 04 §2, doc 03 §5.1). The key's SHA-256 is looked up in
 * `devices` on every request, so a revoked device is cut off at once, also with an unexpired token. Unknown, revoked
 * or malformed keys get `401 DEVICE_KEY_INVALID`.
 *
 * While the database is down a device that passed before is still let in from memory, so `/master-data` can serve
 * its last good copy; an unknown key then gets `503 DB_UNAVAILABLE`. The memory is refreshed by every lookup, so it
 * never outlives a revocation the API has seen.
 */
@Injectable()
export class DeviceKeyGuard implements CanActivate {
  private readonly known = new Map<string, Device>();
  private readonly touched = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepository,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const level = authLevel(this.reflector, context);
    if (level === 'none' || isAdminLevel(level)) return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    this.refuseWhileBlocked(ip, now);

    const header = req.headers['x-device-key'];
    const device =
      typeof header === 'string' && isDeviceKeyShape(header)
        ? await this.lookup(hashDeviceKey(header))
        : null;
    if (!device || device.revokedAt) {
      this.countFailure(ip, now);
      throw new ApiProblem('DEVICE_KEY_INVALID');
    }
    req.device = device;
    await this.touch(device, now);
    return true;
  }

  private async lookup(hash: Buffer): Promise<Device | null> {
    const id = hash.toString('hex');
    let device: Device | null;
    try {
      device = await this.devices.findByKeySha256(hash);
    } catch (error) {
      this.readiness.reportFailure('DB', error);
      const remembered = this.known.get(id);
      if (remembered) return remembered;
      throw new ApiProblem('DB_UNAVAILABLE', { retryAfter: RETRY_MS / 1000 });
    }
    // The index found the row by its hash; compare once more in constant time (doc 03 §6).
    if (!device || !timingSafeEqual(device.keySha256, hash)) {
      this.known.delete(id);
      return null;
    }
    this.known.set(id, device);
    return device;
  }

  private async touch(device: Device, now: number): Promise<void> {
    if (now - (this.touched.get(device.id) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(device.id, now);
    // Bookkeeping only: a failed write must not refuse the request.
    await this.devices.touchLastSeen(device.id).catch(() => undefined);
  }

  private refuseWhileBlocked(ip: string, now: number): void {
    const entry = this.failures.get(ip);
    if (entry && entry.until > now && entry.count >= KEY_FAILURES.limit) {
      throw new ApiProblem('RATE_LIMITED', {
        retryAfter: Math.max(1, Math.ceil((entry.until - now) / 1000)),
      });
    }
  }

  private countFailure(ip: string, now: number): void {
    const entry = this.failures.get(ip);
    if (entry && entry.until > now) {
      entry.count += 1;
      return;
    }
    if (this.failures.size >= 10_000) {
      for (const [key, value] of this.failures) if (value.until <= now) this.failures.delete(key);
    }
    this.failures.set(ip, { count: 1, until: now + KEY_FAILURES.windowMs });
  }
}
