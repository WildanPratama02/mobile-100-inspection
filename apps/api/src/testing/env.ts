import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config, loadConfig } from '../config/env';

/** A complete environment for tests; no value points to anything real. */
export const TEST_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://m100_app:test@127.0.0.1:5432/m100_test',
  PHOTO_STORE: 'disk',
  PHOTO_DIR: 'test-photos',
  JWT_KEY_FILE: 'secrets/jwt.key',
  TZ: 'Asia/Jakarta',
};

/** A fresh signing key per test process, in the system's temp folder. */
const JWT_KEY_FILE = join(tmpdir(), `m100-test-jwt-${process.pid}.key`);
writeFileSync(JWT_KEY_FILE, randomBytes(32));

/** The key an app under test signs its tokens with, to make tokens a test needs (expired, other audience, …). */
export function testJwtKey(): Buffer {
  return readFileSync(JWT_KEY_FILE);
}

/**
 * `PHOTO_DIR` in the system's temp folder: the readiness probe of an app under test writes there, not in `src`.
 * `JWT_KEY_FILE` is this process's test key.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig(TEST_ENV),
    logLevel: 'fatal',
    photoStore: { kind: 'disk', dir: join(tmpdir(), 'm100-test-photos') },
    jwtKeyFile: JWT_KEY_FILE,
    ...overrides,
  };
}
