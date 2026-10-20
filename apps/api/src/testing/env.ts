import { type Config, loadConfig } from '../config/env';

/** A complete environment for tests; no value points to anything real. */
export const TEST_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://m100_app:test@127.0.0.1:5432/m100_test',
  PHOTO_STORE: 'disk',
  PHOTO_DIR: 'test-photos',
  JWT_KEY_FILE: 'secrets/jwt.key',
  TZ: 'Asia/Jakarta',
};

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig(TEST_ENV), logLevel: 'fatal', ...overrides };
}
