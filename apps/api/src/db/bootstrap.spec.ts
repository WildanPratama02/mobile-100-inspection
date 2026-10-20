import { bootstrapPlanFromEnv, scramVerifier } from './bootstrap';

const ENV = {
  ADMIN_DATABASE_URL: 'postgres://postgres:admin-pw@127.0.0.1:5432/postgres',
  MIGRATE_DATABASE_URL: 'postgres://m100_migrate:migrate%40pw@127.0.0.1:5432/m100_dev',
  DATABASE_URL: 'postgres://m100_app:app-pw@127.0.0.1:5432/m100_dev',
  REPORT_DB_PASSWORD: 'report-pw',
};

describe('bootstrapPlanFromEnv (T2.2)', () => {
  it('takes the database and the decoded role passwords from the URLs', () => {
    const { adminUrl, plan } = bootstrapPlanFromEnv(ENV);
    expect(adminUrl).toBe(ENV.ADMIN_DATABASE_URL);
    expect(plan).toEqual({
      database: 'm100_dev',
      migratePassword: 'migrate@pw',
      appPassword: 'app-pw',
      reportPassword: 'report-pw',
    });
  });

  it('leaves m100_report without a password when REPORT_DB_PASSWORD is empty', () => {
    expect(bootstrapPlanFromEnv({ ...ENV, REPORT_DB_PASSWORD: '' }).plan).not.toHaveProperty(
      'reportPassword',
    );
  });

  it('names every missing or wrong variable at once', () => {
    const env = {
      MIGRATE_DATABASE_URL: 'postgres://someone:pw@127.0.0.1:5432/m100_dev',
      DATABASE_URL: 'postgres://m100_app@127.0.0.1:5432/other',
    };
    expect(() => bootstrapPlanFromEnv(env)).toThrow(
      [
        'ADMIN_DATABASE_URL is missing',
        'MIGRATE_DATABASE_URL must log in as m100_migrate',
        'DATABASE_URL must contain the password of m100_app',
        'DATABASE_URL and MIGRATE_DATABASE_URL must name the same database',
      ].join('\n  '),
    );
  });

  it('refuses a database name that would need quoting', () => {
    expect(() =>
      bootstrapPlanFromEnv({
        ...ENV,
        MIGRATE_DATABASE_URL: 'postgres://m100_migrate:pw@127.0.0.1:5432/M100-Dev',
        DATABASE_URL: 'postgres://m100_app:pw@127.0.0.1:5432/M100-Dev',
      }),
    ).toThrow('MIGRATE_DATABASE_URL must name a database');
  });

  it('refuses a password that is not printable ASCII, naming its variable', () => {
    expect(() => bootstrapPlanFromEnv({ ...ENV, REPORT_DB_PASSWORD: 'kata sandi é' })).toThrow(
      'REPORT_DB_PASSWORD: the password must be printable ASCII',
    );
  });
});

describe('scramVerifier (T2.2)', () => {
  it('has the pg_authid format and never contains the password', () => {
    const verifier = scramVerifier('secret-pw');
    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/,
    );
    expect(verifier).not.toContain('secret-pw');
  });

  it('uses a fresh salt each time', () => {
    expect(scramVerifier('secret-pw')).not.toBe(scramVerifier('secret-pw'));
  });

  it('is deterministic for a given salt', () => {
    const salt = Buffer.alloc(16, 7);
    expect(scramVerifier('secret-pw', salt)).toBe(scramVerifier('secret-pw', salt));
  });
});
