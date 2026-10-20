/**
 * One-time database setup behind `pnpm db:bootstrap` (T2.2, doc 03 §6): the roles `m100_migrate`, `m100_app` and
 * `m100_report`, and the database owned by `m100_migrate`. Run by QIP Digital as a PostgreSQL superuser; safe to
 * run again (it then only resets the passwords). Migrations never create roles, they only grant.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { ClientBase } from 'pg';

export const ROLES = { migrate: 'm100_migrate', app: 'm100_app', report: 'm100_report' } as const;

export interface BootstrapPlan {
  database: string;
  migratePassword: string;
  appPassword: string;
  /** Without one, `m100_report` exists but cannot log in until a password is set. */
  reportPassword?: string;
}

export interface BootstrapReport {
  roles: { role: string; action: 'created' | 'updated'; login: boolean }[];
  database: { name: string; action: 'created' | 'existed' };
}

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Printable ASCII: SASLprep leaves it unchanged, so the verifier below matches what the server would compute. */
const PASSWORD = /^[\x20-\x7e]+$/;

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for `password` (RFC 5802, RFC 7677; the format of `pg_authid`).
 * Sending this instead of the password keeps the password out of the server log and `pg_stat_statements`, which
 * record `CREATE ROLE … PASSWORD '…'` as written.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  if (!PASSWORD.test(password)) throw new Error('Role passwords must be printable ASCII');
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** Reads the plan from `ADMIN_DATABASE_URL`, `MIGRATE_DATABASE_URL`, `DATABASE_URL` and `REPORT_DB_PASSWORD`. */
export function bootstrapPlanFromEnv(env: Readonly<Record<string, string | undefined>>): {
  adminUrl: string;
  plan: BootstrapPlan;
} {
  const problems: string[] = [];
  const url = (name: string, role?: string): URL | undefined => {
    const value = env[name]?.trim();
    if (!value) {
      problems.push(`${name} is missing`);
      return undefined;
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      problems.push(`${name} must be a postgres:// URL`);
      return undefined;
    }
    if (!/^postgres(ql)?:$/.test(parsed.protocol))
      problems.push(`${name} must be a postgres:// URL`);
    if (role && decodeURIComponent(parsed.username) !== role)
      problems.push(`${name} must log in as ${role}`);
    if (role && !parsed.password) problems.push(`${name} must contain the password of ${role}`);
    return parsed;
  };

  const admin = url('ADMIN_DATABASE_URL');
  const migrateUrl = url('MIGRATE_DATABASE_URL', ROLES.migrate);
  const appUrl = url('DATABASE_URL', ROLES.app);
  const database = migrateUrl ? decodeURIComponent(migrateUrl.pathname.slice(1)) : '';
  if (migrateUrl && !DATABASE_NAME.test(database)) {
    problems.push('MIGRATE_DATABASE_URL must name a database (lower case letters, digits, _)');
  }
  if (appUrl && migrateUrl && appUrl.pathname !== migrateUrl.pathname) {
    problems.push('DATABASE_URL and MIGRATE_DATABASE_URL must name the same database');
  }
  if (problems.length > 0 || !admin || !migrateUrl || !appUrl) {
    throw new Error(`Cannot bootstrap the database:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  const reportPassword = env.REPORT_DB_PASSWORD?.trim();
  const passwords: [string, string][] = [
    ['MIGRATE_DATABASE_URL', decodeURIComponent(migrateUrl.password)],
    ['DATABASE_URL', decodeURIComponent(appUrl.password)],
    ...(reportPassword ? [['REPORT_DB_PASSWORD', reportPassword] as [string, string]] : []),
  ];
  const bad = passwords.filter(([, p]) => !PASSWORD.test(p)).map(([name]) => name);
  if (bad.length > 0) {
    throw new Error(
      `Cannot bootstrap the database:\n${bad.map((name) => `  ${name}: the password must be printable ASCII`).join('\n')}`,
    );
  }
  return {
    adminUrl: admin.href,
    plan: {
      database,
      migratePassword: decodeURIComponent(migrateUrl.password),
      appPassword: decodeURIComponent(appUrl.password),
      ...(reportPassword ? { reportPassword } : {}),
    },
  };
}

async function roleExists(client: ClientBase, role: string): Promise<boolean> {
  const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  return rowCount === 1;
}

/**
 * Creates `role` without login if it is missing; leaves an existing role alone. Used where only the grants matter
 * (the test databases, whose files run in parallel and may race to create the same role).
 */
export async function ensureRole(client: ClientBase, role: string): Promise<void> {
  if (await roleExists(client, role)) return;
  try {
    await client.query(`CREATE ROLE ${client.escapeIdentifier(role)} NOLOGIN`);
  } catch (error) {
    // 42710 duplicate_object, or 23505 when the other session's insert into pg_authid wins the race.
    const code = (error as { code?: string }).code;
    if ((code !== '42710' && code !== '23505') || !(await roleExists(client, role))) throw error;
  }
}

/** Runs the plan on `admin`, a superuser connection. Passwords are never logged or returned. */
export async function bootstrap(admin: ClientBase, plan: BootstrapPlan): Promise<BootstrapReport> {
  const report: BootstrapReport = {
    roles: [],
    database: { name: plan.database, action: 'existed' },
  };

  const wanted: [string, string | undefined][] = [
    [ROLES.migrate, plan.migratePassword],
    [ROLES.app, plan.appPassword],
    [ROLES.report, plan.reportPassword],
  ];
  for (const [role, password] of wanted) {
    // Utility statements take no parameters, so the verifier (never the password) goes in as a literal.
    const login = password
      ? `LOGIN PASSWORD ${admin.escapeLiteral(scramVerifier(password))}`
      : 'NOLOGIN';
    const options = `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS ${login}`;
    const exists = await roleExists(admin, role);
    await admin.query(
      `${exists ? 'ALTER' : 'CREATE'} ROLE ${admin.escapeIdentifier(role)} ${options}`,
    );
    report.roles.push({ role, action: exists ? 'updated' : 'created', login: Boolean(password) });
  }

  const db = admin.escapeIdentifier(plan.database);
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    plan.database,
  ]);
  if (rowCount === 0) {
    await admin.query(
      `CREATE DATABASE ${db} OWNER ${ROLES.migrate} ENCODING 'UTF8' TEMPLATE template0`,
    );
    report.database.action = 'created';
  } else {
    await admin.query(`ALTER DATABASE ${db} OWNER TO ${ROLES.migrate}`);
  }
  await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${ROLES.app}, ${ROLES.report}`);
  // Sessions run in WIB (doc 02); stored values are timestamptz either way.
  await admin.query(`ALTER DATABASE ${db} SET timezone TO 'Asia/Jakarta'`);
  return report;
}
