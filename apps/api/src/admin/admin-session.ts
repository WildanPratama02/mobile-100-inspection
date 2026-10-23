/**
 * The admin session (doc 04 §2, §8; doc 03 §6): an HS256 token with `aud` = `admin`, valid 8 hours, in the
 * cookie `m100_admin` (`HttpOnly; Secure; SameSite=Strict`, path `/v1/admin`, so the browser never sends it to
 * tablet endpoints). Claims: `sub` = username, `aid` = admin id. State-changing requests also carry
 * `X-Requested-With: m100-admin`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TokenSigner } from '../auth/jwt';

export const ADMIN_COOKIE = 'm100_admin';
export const ADMIN_COOKIE_PATH = '/v1/admin';
export const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;
export const REQUESTED_WITH = { header: 'x-requested-with', value: 'm100-admin' } as const;

export interface AdminClaims {
  sub: string;
  aid: number;
}

const claimsSchema = z.object({ sub: z.string().min(1), aid: z.number().int().positive() });

@Injectable()
export class AdminTokens {
  constructor(@Inject(TokenSigner) private readonly signer: TokenSigner) {}

  issue(claims: AdminClaims, now = new Date()): { token: string; expiresAt: Date } {
    return this.signer.sign(
      { sub: claims.sub, aid: claims.aid },
      { audience: 'admin', now, lifetimeSeconds: SESSION_LIFETIME_SECONDS },
    );
  }

  /** The claims of a valid admin token, or `null` (wrong audience, expired, tampered, …). */
  verify(token: string, now = new Date()): AdminClaims | null {
    const result = this.signer.verify(token, { audience: 'admin', now });
    if (!result.ok) return null;
    const claims = claimsSchema.safeParse(result.claims);
    return claims.success ? claims.data : null;
  }
}

const COOKIE_ATTRIBUTES = `Path=${ADMIN_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;

/** The `Set-Cookie` value of a new session. */
export function sessionCookie(token: string): string {
  return `${ADMIN_COOKIE}=${token}; Max-Age=${SESSION_LIFETIME_SECONDS}; ${COOKIE_ATTRIBUTES}`;
}

/** The `Set-Cookie` value that ends the session in the browser. */
export function clearedCookie(): string {
  return `${ADMIN_COOKIE}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}

/** The value of cookie `name` in a `Cookie` header, or `null`. */
export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}
