/**
 * HS256 JSON Web Tokens with `node:crypto` (doc 03 §5.1, §6). The API only ever verifies tokens it signed itself,
 * so the header is fixed: a token whose header names any other algorithm (`none`, `RS256`, …) is invalid, and the
 * audience (`tablet`, or `admin` for T3b.1) must match the caller's. Signatures are compared in constant time.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type Audience = 'tablet' | 'admin';

/** Claims every token of this API carries, in seconds since the epoch. */
export interface StandardClaims {
  aud: Audience;
  iat: number;
  exp: number;
}

export type VerifyResult =
  | { ok: true; claims: Record<string, unknown> & StandardClaims }
  | { ok: false; reason: 'invalid' | 'expired' };

const HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const PART = /^[A-Za-z0-9_-]+$/;

export class TokenSigner {
  constructor(private readonly key: Buffer) {}

  /** A token for `audience` that expires `lifetimeSeconds` after `now`. */
  sign(
    claims: Record<string, unknown>,
    { audience, now, lifetimeSeconds }: { audience: Audience; now: Date; lifetimeSeconds: number },
  ): { token: string; expiresAt: Date } {
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + lifetimeSeconds;
    const payload = base64url(JSON.stringify({ ...claims, aud: audience, iat, exp }));
    const signed = `${HEADER}.${payload}`;
    return { token: `${signed}.${this.signature(signed)}`, expiresAt: new Date(exp * 1000) };
  }

  /**
   * The claims of a token signed with this key for `audience`. `expired` when `now` is past `exp` plus
   * `graceSeconds`; `invalid` for anything else that is wrong.
   */
  verify(
    token: string,
    { audience, now, graceSeconds = 0 }: { audience: Audience; now: Date; graceSeconds?: number },
  ): VerifyResult {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((part) => PART.test(part))) return invalid();
    const [header, payload, signature] = parts as [string, string, string];
    const expected = Buffer.from(this.signature(`${header}.${payload}`), 'base64url');
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return invalid();

    const head = parseJson(header);
    if (head?.alg !== 'HS256') return invalid();
    const claims = parseJson(payload);
    if (
      claims?.aud !== audience ||
      !Number.isInteger(claims.iat) ||
      !Number.isInteger(claims.exp)
    ) {
      return invalid();
    }
    const { exp } = claims as unknown as StandardClaims;
    if (Math.floor(now.getTime() / 1000) >= exp + graceSeconds) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, claims: claims as Record<string, unknown> & StandardClaims };
  }

  private signature(signed: string): string {
    return createHmac('sha256', this.key).update(signed).digest('base64url');
  }
}

function invalid(): VerifyResult {
  return { ok: false, reason: 'invalid' };
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function parseJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
