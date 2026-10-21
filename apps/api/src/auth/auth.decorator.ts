import { type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Device } from '../repositories/device.repository';
import type { TabletClaims } from './tablet-token';

/**
 * What a tablet route needs (doc 04 §2): `none` (`/health`), `device` (the device key only: `/system/status`,
 * `/master-data`, `/auth/login`, `/auth/refresh`) or `tablet` (device key and user token). Routes without the
 * decorator need both, as the OpenAPI default security says.
 */
export type AuthLevel = 'none' | 'device' | 'tablet';

const AUTH_LEVEL = 'm100:auth-level';

export const Auth = (level: AuthLevel) => SetMetadata(AUTH_LEVEL, level);

export function authLevel(reflector: Reflector, context: ExecutionContext): AuthLevel {
  return (
    reflector.getAllAndOverride<AuthLevel | undefined>(AUTH_LEVEL, [
      context.getHandler(),
      context.getClass(),
    ]) ?? 'tablet'
  );
}

/** A request after the guards: `device` set by `DeviceKeyGuard`, `tablet` by `TokenGuard`. */
export interface AuthRequest extends Request {
  device?: Device;
  tablet?: TabletClaims;
}
