import { type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Device } from '../repositories/device.repository';
import type { TabletClaims } from './tablet-token';

/**
 * What a route needs (doc 04 §2). Tablet routes: `none` (`/health`), `device` (the device key only:
 * `/system/status`, `/master-data`, `/auth/login`, `/auth/refresh`) or `tablet` (device key and user token).
 * Admin routes need no device key: `admin-login` (`/admin/auth/login`, no session yet) or `admin` (the admin
 * session cookie). Routes without the decorator need device key and token, as the OpenAPI default security says.
 */
export type AuthLevel = 'none' | 'device' | 'tablet' | 'admin-login' | 'admin';

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

/** Levels of the admin API (doc 04 §8), which the tablet guards leave to `AdminGuard`. */
export function isAdminLevel(level: AuthLevel): level is 'admin-login' | 'admin' {
  return level === 'admin-login' || level === 'admin';
}

/** The signed-in admin, as `AdminGuard` found it in the database. */
export interface AdminPrincipal {
  id: number;
  username: string;
}

/** A request after the guards: `device` set by `DeviceKeyGuard`, `tablet` by `TokenGuard`, `admin` by `AdminGuard`. */
export interface AuthRequest extends Request {
  device?: Device;
  tablet?: TabletClaims;
  admin?: AdminPrincipal;
}
