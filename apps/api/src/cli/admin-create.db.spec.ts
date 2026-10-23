import { PassThrough } from 'node:stream';
import { verifyPassword } from '../admin/passwords';
import { createPool, Database } from '../db/database';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { runAdminCreate } from './admin-create';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
});
afterAll(async () => {
  await testDb?.drop();
});

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

/** Runs the command with `stdin` piped in; returns what it printed and the error it failed with, if any. */
async function run(
  args: string[],
  { stdin = '', env = { NODE_ENV: 'test' } }: { stdin?: string; env?: Record<string, string> } = {},
): Promise<{ output: string; error?: Error }> {
  const input = new PassThrough();
  input.end(stdin);
  const output = sink();
  const prompt = sink();
  let error: Error | undefined;
  await runAdminCreate(args, {
    env,
    input,
    output: output.stream,
    prompt: prompt.stream,
    openDatabase: () => new Database(createPool(testDb.url('m100_app'), 'm100 test admin:create')),
  }).catch((e: Error) => {
    error = e;
  });
  return { output: output.text() + prompt.text(), error };
}

async function rows(): Promise<unknown> {
  const admins = await testDb.client.query('SELECT * FROM admins ORDER BY id');
  const audit = await testDb.client.query('SELECT * FROM audit_log ORDER BY id');
  return { admins: admins.rows, audit: audit.rows };
}

describe('pnpm admin:create (doc 03 §6, §7.4)', () => {
  it('creates the named admin from a piped password and never prints it', async () => {
    const result = await run(['--username', 'qip.digital'], { stdin: 'a-strong-password-1\n' });
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('Admin "qip.digital" created.\n');
    const { rows: admins } = await testDb.client.query<{ password_hash: string }>(
      `SELECT password_hash FROM admins WHERE username = 'qip.digital'`,
    );
    expect(await verifyPassword(admins[0]!.password_hash, 'a-strong-password-1')).toBe(true);
  });

  it('defaults the username to admin, still with a password of at least 10 characters', async () => {
    const before = await rows();
    const weak = await run([], { stdin: 'admin123\n' });
    expect(weak.error?.message).toBe('Password minimal 10 karakter.');
    expect(await rows()).toEqual(before);

    const result = await run([], { stdin: 'production-grade-pass\n' });
    expect(result.output).toBe('Admin "admin" created.\n');
    expect(result.output).not.toContain('production-grade-pass');
  });

  it('--reset sets a new password; a weak one is refused', async () => {
    const weak = await run(['--username', 'admin', '--reset'], { stdin: 'short\n' });
    expect(weak.error?.message).toBe('Password minimal 10 karakter.');
    const result = await run(['--username', 'admin', '--reset'], {
      stdin: 'rotated-password-3\n',
    });
    expect(result.output).toBe('New password set for admin "admin".\n');
    expect(result.output).not.toContain('rotated-password-3');
  });

  it('refuses a second admin with a taken username', async () => {
    const result = await run(['--username', 'qip.digital'], { stdin: 'a-strong-password-1\n' });
    expect(result.error?.message).toContain('already exists; use --reset');
  });
});

describe('pnpm admin:create --dev-default', () => {
  let devDb: TestDatabase;

  beforeAll(async () => {
    // A database of its own: the one above already has an `admin`.
    devDb = await createTestDatabase({ migrated: true });
  });
  afterAll(async () => {
    await devDb?.drop();
  });

  async function runDev(args: string[], env: Record<string, string>) {
    const output = sink();
    let error: Error | undefined;
    await runAdminCreate(args, {
      env,
      input: new PassThrough(),
      output: output.stream,
      prompt: output.stream,
      openDatabase: () => new Database(createPool(devDb.url('m100_app'), 'm100 test admin:create')),
    }).catch((e: Error) => {
      error = e;
    });
    return { output: output.text(), error };
  }

  async function devRows(): Promise<unknown> {
    const admins = await devDb.client.query('SELECT * FROM admins ORDER BY id');
    const audit = await devDb.client.query('SELECT * FROM audit_log ORDER BY id');
    return { admins: admins.rows, audit: audit.rows };
  }

  it('refuses in production, without NODE_ENV, and with other options; writes nothing', async () => {
    const before = await devRows();
    for (const env of [{ NODE_ENV: 'production' }, {}] as Record<string, string>[]) {
      const result = await runDev(['--dev-default'], env);
      expect(result.error?.message).toMatch(/NODE_ENV/);
      expect(result.output).toBe('');
    }
    for (const extra of [['--reset'], ['--username', 'admin']]) {
      const result = await runDev(['--dev-default', ...extra], { NODE_ENV: 'development' });
      expect(result.error?.message).toContain('--dev-default takes no other option');
    }
    expect(await devRows()).toEqual(before);
  });

  it('creates admin with the development default in a test database, without printing the password', async () => {
    const result = await runDev(['--dev-default'], { NODE_ENV: 'development' });
    expect(result.error).toBeUndefined();
    expect(result.output).toBe(
      `Development admin "admin" created in ${devDb.name} with the development default password. ` +
        'Never use it outside development.\n',
    );
    expect(result.output).not.toContain('admin123');

    const again = await runDev(['--dev-default'], { NODE_ENV: 'development' });
    expect(again.output).toBe(`Admin "admin" already exists in ${devDb.name}; nothing changed.\n`);
  });
});
