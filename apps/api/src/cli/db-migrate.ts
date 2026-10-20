/**
 * `pnpm db:migrate`: applies `db/migrations/` with `MIGRATE_DATABASE_URL` (role `m100_migrate`, doc 03 §7.4). Reads
 * `.env` from the working directory, like the API.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { migrate } from '../db/migrate';

async function main(): Promise<void> {
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.MIGRATE_DATABASE_URL?.trim();
  if (!url) throw new Error('MIGRATE_DATABASE_URL is missing');

  const client = new Client({ connectionString: url, application_name: 'm100 db:migrate' });
  await client.connect();
  try {
    const { applied, alreadyApplied } = await migrate(client);
    process.stdout.write(
      applied.length === 0
        ? `Nothing to apply; ${alreadyApplied.length} migrations already applied.\n`
        : `Applied ${applied.join(', ')} (${alreadyApplied.length} were already applied).\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`db:migrate failed: ${(error as Error).message}\n`);
  process.exit(1);
});
