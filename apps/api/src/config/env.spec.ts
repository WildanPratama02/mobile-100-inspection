import { TEST_ENV } from '../testing/env';
import { ConfigError, loadConfig } from './env';

function without(...names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(TEST_ENV).filter(([k]) => !names.includes(k)));
}

function variablesOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.variables;
    throw error;
  }
  throw new Error('loadConfig accepted the environment');
}

describe('loadConfig (doc 03 §7.4)', () => {
  it('reads a complete environment and fills the defaults', () => {
    expect(loadConfig(TEST_ENV)).toEqual({
      databaseUrl: TEST_ENV.DATABASE_URL,
      photoStore: { kind: 'disk', dir: 'test-photos' },
      jwtKeyFile: 'secrets/jwt.key',
      masterCheckSeconds: 300,
      submitTimeoutSeconds: 60,
      logLevel: 'info',
      port: 3000,
    });
  });

  it('reads the tunables when they are set', () => {
    const config = loadConfig({
      ...TEST_ENV,
      MASTER_CHECK_SECONDS: '120',
      SUBMIT_TIMEOUT_SECONDS: '30',
      LOG_LEVEL: 'debug',
      PORT: '3100',
    });
    expect(config).toMatchObject({
      masterCheckSeconds: 120,
      submitTimeoutSeconds: 30,
      logLevel: 'debug',
      port: 3100,
    });
  });

  it('names a missing DATABASE_URL', () => {
    expect(() => loadConfig(without('DATABASE_URL'))).toThrow(/DATABASE_URL is missing/);
  });

  it('names every missing variable at once', () => {
    expect(variablesOf({}).sort()).toEqual(['DATABASE_URL', 'JWT_KEY_FILE', 'PHOTO_STORE', 'TZ']);
  });

  it('treats an empty value as missing', () => {
    expect(variablesOf({ ...TEST_ENV, JWT_KEY_FILE: '  ' })).toEqual(['JWT_KEY_FILE']);
  });

  it('needs PHOTO_DIR for the disk store', () => {
    expect(variablesOf(without('PHOTO_DIR'))).toEqual(['PHOTO_DIR']);
  });

  it('needs the four S3 variables for the s3 store', () => {
    expect(variablesOf({ ...without('PHOTO_DIR'), PHOTO_STORE: 's3' }).sort()).toEqual([
      'S3_ACCESS_KEY',
      'S3_BUCKET',
      'S3_ENDPOINT',
      'S3_SECRET_KEY',
    ]);
    const s3 = loadConfig({
      ...TEST_ENV,
      PHOTO_STORE: 's3',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_BUCKET: 'm100-photos',
      S3_ACCESS_KEY: 'key',
      S3_SECRET_KEY: 'secret',
    });
    expect(s3.photoStore).toEqual({
      kind: 's3',
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'm100-photos',
      accessKey: 'key',
      secretKey: 'secret',
    });
  });

  it.each([
    ['PHOTO_STORE', 'minio'],
    ['TZ', 'UTC'],
    ['DATABASE_URL', 'mysql://localhost/m100'],
    ['LOG_LEVEL', 'verbose'],
    ['PORT', 'abc'],
    ['MASTER_CHECK_SECONDS', '0'],
  ])('rejects %s=%s by name', (name, value) => {
    expect(variablesOf({ ...TEST_ENV, [name]: value })).toEqual([name]);
  });

  it('never prints a value in the message', () => {
    const env = { ...TEST_ENV, DATABASE_URL: 'mysql://user:hunter2@host/db' };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).not.toThrow(/hunter2/);
  });
});
