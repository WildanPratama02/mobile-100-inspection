import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../config/env';
import { generateDeviceKey, hashDeviceKey, isDeviceKeyShape, setupLink } from './device-key';
import { readJwtKey } from './jwt-key';

describe('device keys (ADR-014, doc 03 §6)', () => {
  it('are 32 random bytes in base64url, different every time', () => {
    const keys = Array.from({ length: 50 }, generateDeviceKey);
    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(key, 'base64url')).toHaveLength(32);
      expect(isDeviceKeyShape(key)).toBe(true);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('are stored as their SHA-256 only', () => {
    const key = generateDeviceKey();
    expect(hashDeviceKey(key)).toEqual(createHash('sha256').update(key).digest());
    expect(hashDeviceKey(key)).toHaveLength(32);
  });

  it.each([
    '',
    'short',
    `${generateDeviceKey()}x`,
    `${generateDeviceKey().slice(1)}=`,
    'a'.repeat(42) + '/',
  ])('refuses the shape %j without a lookup', (value) => {
    expect(isDeviceKeyShape(value)).toBe(false);
  });

  it('go into the setup link as its fragment (doc 03 §4.9)', () => {
    expect(setupLink('m100.qdms.web.id', 'abc_-')).toBe('https://m100.qdms.web.id/setup#k=abc_-');
  });
});

describe('JWT_KEY_FILE (doc 03 §6)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm100-jwt-key-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is read as raw bytes', () => {
    const file = join(dir, 'jwt.key');
    const bytes = randomBytes(32);
    writeFileSync(file, bytes);
    expect(readJwtKey(file)).toEqual(bytes);
  });

  it('stops the start, naming JWT_KEY_FILE, when shorter than 32 bytes', () => {
    const file = join(dir, 'short.key');
    writeFileSync(file, randomBytes(31));
    expect(() => readJwtKey(file)).toThrow(ConfigError);
    expect(() => readJwtKey(file)).toThrow(/JWT_KEY_FILE must hold at least 32 bytes/);
  });

  it('stops the start, naming JWT_KEY_FILE, when missing', () => {
    let error: unknown;
    try {
      readJwtKey(join(dir, 'missing.key'));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).variables).toEqual(['JWT_KEY_FILE']);
    expect((error as Error).message).toMatch(/JWT_KEY_FILE cannot be read .*ENOENT/);
  });
});
