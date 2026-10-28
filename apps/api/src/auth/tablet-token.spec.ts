import { createHmac, randomBytes } from 'node:crypto';
import { tamperSignature } from '../testing/tamper';
import { TokenSigner } from './jwt';
import {
  bearerToken,
  REFRESH_GRACE_SECONDS,
  type TabletClaims,
  TabletTokens,
  TOKEN_LIFETIME_SECONDS,
} from './tablet-token';

const key = randomBytes(32);
const signer = new TokenSigner(key);
const tokens = new TabletTokens(signer);
const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-21T08:00:00.000Z');

const claims: TabletClaims = {
  sub: 'TEST BUDI',
  lvl: 'PSI lv.2',
  fac: 'F 1',
  cel: 'F1-1',
  dev: '9b0f9d6e-1c1a-4f57-9d55-3c1f2b6a7e01',
};

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** A token with any header and payload, signed with `signKey`. */
function forge(header: object, payload: object, signKey: Buffer = key): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = createHmac('sha256', signKey).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

const iat = Math.floor(now.getTime() / 1000);
const valid = { ...claims, aud: 'tablet', iat, exp: iat + 60 };

describe('tablet token (doc 04 §2, ADR-014)', () => {
  it('carries sub, lvl, fac, cel, dev and aud = tablet, and lives 30 days', () => {
    const { token, expiresAt } = tokens.issue(claims, now);
    const [header, payload] = token.split('.') as [string, string, string];
    expect(decode(header)).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(decode(payload)).toEqual({
      ...claims,
      aud: 'tablet',
      iat,
      exp: iat + TOKEN_LIFETIME_SECONDS,
    });
    expect(TOKEN_LIFETIME_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(expiresAt.getTime()).toBe(now.getTime() + 30 * DAY);
    expect(tokens.verify(token, { now })).toEqual({ ok: true, claims, expiresAt });
  });

  it('is expired from its exp on; with the refresh grace it is accepted for 30 more days', () => {
    const { token } = tokens.issue(claims, now);
    const exp = now.getTime() + 30 * DAY;
    expect(tokens.verify(token, { now: new Date(exp - 1000) }).ok).toBe(true);
    expect(tokens.verify(token, { now: new Date(exp) })).toEqual({ ok: false, reason: 'expired' });
    const grace = { graceSeconds: REFRESH_GRACE_SECONDS };
    expect(tokens.verify(token, { now: new Date(exp + 30 * DAY - 1000), ...grace }).ok).toBe(true);
    expect(tokens.verify(token, { now: new Date(exp + 30 * DAY), ...grace })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it.each<[string, () => string]>([
    ['an admin token', () => forge({ alg: 'HS256', typ: 'JWT' }, { ...valid, aud: 'admin' })],
    [
      'alg none without signature',
      () => `${forge({ alg: 'none' }, valid).split('.').slice(0, 2).join('.')}.`,
    ],
    ['alg none, signed', () => forge({ alg: 'none', typ: 'JWT' }, valid)],
    ['another algorithm', () => forge({ alg: 'HS512', typ: 'JWT' }, valid)],
    ['another key', () => forge({ alg: 'HS256', typ: 'JWT' }, valid, randomBytes(32))],
    ['no exp', () => forge({ alg: 'HS256' }, { ...valid, exp: undefined })],
    ['a level that does not exist', () => forge({ alg: 'HS256' }, { ...valid, lvl: 'CFA' })],
    ['a device id that is not a uuid', () => forge({ alg: 'HS256' }, { ...valid, dev: 'x' })],
    ['a missing claim', () => forge({ alg: 'HS256' }, { ...valid, cel: undefined })],
    ['two parts', () => tokens.issue(claims, now).token.split('.').slice(0, 2).join('.')],
    ['garbage', () => 'not a token'],
  ])('refuses %s as invalid', (_name, make) => {
    expect(tokens.verify(make(), { now })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a changed payload or signature as invalid', () => {
    const [h, p, s] = tokens.issue(claims, now).token.split('.') as [string, string, string];
    const other = Buffer.from(JSON.stringify({ ...decode(p), sub: 'TEST DEWI' })).toString(
      'base64url',
    );
    expect(tokens.verify(`${h}.${other}.${s}`, { now }).ok).toBe(false);
    expect(tokens.verify(tamperSignature(`${h}.${p}.${s}`), { now }).ok).toBe(false);
  });

  it('accepts a forged-looking token only when it is really signed with the key', () => {
    expect(tokens.verify(forge({ alg: 'HS256', typ: 'JWT' }, valid), { now }).ok).toBe(true);
  });
});

describe('bearerToken', () => {
  it.each<[string | undefined, string | null]>([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc', 'abc'],
    ['Basic abc', null],
    ['Bearer', null],
    ['Bearer a b', null],
    [undefined, null],
  ])('%s → %s', (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });
});
