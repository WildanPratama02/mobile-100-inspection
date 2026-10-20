/**
 * `pnpm db:bootstrap`: creates the roles and the database once (doc 03 §6), as the superuser in
 * `ADMIN_DATABASE_URL`. Role passwords come from `MIGRATE_DATABASE_URL`, `DATABASE_URL` and `REPORT_DB_PASSWORD`.
 * Reads `.env` from the working directory. Then run `pnpm db:migrate`.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { bootstrap, bootstrapPlanFromEnv } from '../db/bootstrap';

async function main(): Promise<void> {
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { adminUrl, plan } = bootstrapPlanFromEnv(process.env);

  const client = new Client({ connectionString: adminUrl, application_name: 'm100 db:bootstrap' });
  await client.connect();
  try {
    const report = await bootstrap(client, plan);
    for (const r of report.roles) {
      process.stdout.write(
        `Role ${r.role} ${r.action}${r.login ? '' : ' (NOLOGIN: no password given)'}\n`,
      );
    }
    process.stdout.write(
      `Database ${report.database.name} ${report.database.action}, owner m100_migrate\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`db:bootstrap failed: ${(error as Error).message}\n`);
  process.exit(1);
});
