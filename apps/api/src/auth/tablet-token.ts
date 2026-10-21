/**
 * The PSI's token (doc 04 §2, ADR-014): HS256, `aud` = `tablet`, valid 30 days, claims `sub` (username), `lvl`
 * (PSI level), `fac`, `cel` and `dev` (the device it was issued to). `POST /auth/refresh` also accepts a token up
 * to 30 days past its expiry, so an outbox item whose author's token ran out can still be sent (doc 04 §2, A7).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { PsiLevel } from '@m100/shared';
import { z } from 'zod';
import { TokenSigner } from './jwt';

const DAY_SECONDS = 24 * 60 * 60;
export const TOKEN_LIFETIME_SECONDS = 30 * DAY_SECONDS;
export const REFRESH_GRACE_SECONDS = 30 * DAY_SECONDS;

export interface TabletClaims {
  sub: string;
  lvl: PsiLevel;
  fac: string;
  cel: string;
  dev: string;
}

const claimsSchema = z.object({
  sub: z.string().min(1),
  lvl: z.enum(['PSI lv.1', 'PSI lv.2']),
  fac: z.string().min(1),
  cel: z.string().min(1),
  dev: z.uuid(),
});

export type TabletVerifyResult =
  | { ok: true; claims: TabletClaims; expiresAt: Date }
  | { ok: false; reason: 'invalid' | 'expired' };

@Injectable()
export class TabletTokens {
  constructor(@Inject(TokenSigner) private readonly signer: TokenSigner) {}

  issue(claims: TabletClaims, now = new Date()): { token: string; expiresAt: Date } {
    const { sub, lvl, fac, cel, dev } = claims;
    return this.signer.sign(
      { sub, lvl, fac, cel, dev },
      { audience: 'tablet', now, lifetimeSeconds: TOKEN_LIFETIME_SECONDS },
    );
  }

  /** `graceSeconds` lets an expired token through for that long after `exp` (refresh only). */
  verify(token: string, { now = new Date(), graceSeconds = 0 } = {}): TabletVerifyResult {
    const result = this.signer.verify(token, { audience: 'tablet', now, graceSeconds });
    if (!result.ok) return result;
    const claims = claimsSchema.safeParse(result.claims);
    if (!claims.success) return { ok: false, reason: 'invalid' };
    return { ok: true, claims: claims.data, expiresAt: new Date(result.claims.exp * 1000) };
  }
}

/** The token of `Authorization: Bearer <token>`, or `null`. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer +(\S+)$/i.exec(header?.trim() ?? '');
  return match?.[1] ?? null;
}
