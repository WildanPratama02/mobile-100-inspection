/**
 * `pnpm import-master --dir <folder> [--mapping <file>] [--dry-run]` (doc 02 §5.1, doc 03 §7.5): imports the
 * exported old sheets and the mapping workbook with `DATABASE_URL` (role `m100_app`). Reads `.env` from the working
 * directory, like the API. Relative paths are taken from the folder the command was started in. The report shows
 * counts, PO numbers and row numbers only, never a person's name.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPool, Database } from '../db/database';
import { importMaster, type ImportResult, pgImportRepositories } from '../import/import-master';
import { ImportInvalid, parseMaster } from '../import/parse-master';
import { problemLines, reportLines } from '../import/report';
import { findSources, readSources, SourceError, type SourceFiles } from '../import/sources';

const USAGE = 'Usage: pnpm import-master --dir <folder> [--mapping <file>] [--dry-run]';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      mapping: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.dir) throw new SourceError(`--dir is missing\n${USAGE}`);
  // pnpm runs the script in apps/api; INIT_CWD is where the person typed the command.
  const base = process.env.INIT_CWD ?? process.cwd();
  const sources = findSources(
    resolve(base, values.dir),
    values.mapping ? resolve(base, values.mapping) : undefined,
  );
  const dryRun = values['dry-run'];

  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL is missing');

  const out = (line = '') => process.stdout.write(`${line}\n`);
  out(`${dryRun ? 'DRY RUN, nothing is written. ' : ''}Reading ${describe(sources)}`);
  const parsed = parseMaster(await readSources(sources));
  for (const line of reportLines(parsed.report)) out(line);

  const db = new Database(createPool(url, 'm100 import-master'));
  try {
    const result = await importMaster(db, pgImportRepositories(db), parsed, { dryRun });
    printResult(result, out);
  } finally {
    await db.end();
  }
}

function describe(sources: SourceFiles): string {
  const old =
    sources.old.kind === 'xlsx' ? sources.old.file : Object.values(sources.old.files).join(', ');
  return `${old} and ${sources.mapping}`;
}

function printResult(result: ImportResult, out: (line?: string) => void): void {
  out();
  out(result.dryRun ? 'Would write (rolled back):' : 'Written:');
  for (const [table, c] of Object.entries(result.tables)) {
    out(
      `  ${table.padEnd(10)} ${c.inserted} inserted, ${c.updated} updated, ${c.unchanged} unchanged`,
    );
  }
  out(
    result.dryRun
      ? `master_version stays ${result.masterVersion}.`
      : result.changed
        ? `master_version is now ${result.masterVersion}.`
        : `Nothing changed; master_version stays ${result.masterVersion}.`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof ImportInvalid) {
    process.stderr.write(`import-master stopped: ${error.message}\n`);
    for (const line of problemLines(error.problems)) process.stderr.write(`${line}\n`);
  } else {
    process.stderr.write(`import-master failed: ${(error as Error).message}\n`);
  }
  process.exit(1);
});
