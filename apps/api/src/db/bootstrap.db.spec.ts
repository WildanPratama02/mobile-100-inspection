import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { adminUrl } from '../testing/database';
import { scramVerifier } from './bootstrap';

/**
 * The verifier db:bootstrap stores must let the role log in with the plain password. Checked with a throw-away role,
 * never with the m100_* roles, whose passwords belong to the developer's .env.
 */
describe('scramVerifier against PostgreSQL (T2.2)', () => {
  const role = `m100_scram_test_${randomBytes(4).toString('hex')}`;
  const password = `pw-${randomBytes(12).toString('hex')}`;
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl().href });
    await admin.connect();
    await admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD ${admin.escapeLiteral(scramVerifier(password))}`,
    );
  });
  afterAll(async () => {
    await admin?.query(`DROP ROLE IF EXISTS ${role}`);
    await admin?.end();
  });

  function urlFor(secret: string): string {
    const url = adminUrl();
    url.username = role;
    url.password = encodeURIComponent(secret);
    url.pathname = '/postgres';
    return url.href;
  }

  it('stores the verifier itself, not a hash of it', async () => {
    const { rows } = await admin.query<{ rolpassword: string }>(
      'SELECT rolpassword FROM pg_authid WHERE rolname = $1',
      [role],
    );
    expect(rows[0]?.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
  });

  it('lets the role log in with the password', async () => {
    const client = new Client({ connectionString: urlFor(password) });
    await client.connect();
    try {
      const { rows } = await client.query<{ user: string }>('SELECT current_user AS user');
      expect(rows[0]?.user).toBe(role);
    } finally {
      await client.end();
    }
  });

  it('refuses a wrong password', async () => {
    const client = new Client({ connectionString: urlFor(`${password}x`) });
    await expect(client.connect()).rejects.toMatchObject({ code: '28P01' });
  });
});
