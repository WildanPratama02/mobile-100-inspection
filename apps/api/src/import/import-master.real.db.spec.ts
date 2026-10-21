/**
 * T2.4 acceptance on the real exports (doc 08). The files hold personal names and stay out of the repository
 * (decided 21 Oct 2026); this test runs only when `MASTER_DATA_DIR` names the folder that holds them, e.g.
 * `secrets/master-data/`. It prints the import report (counts, PO and row numbers only) for the run log.
 */
import { resolve } from 'node:path';
import { Database } from '../db/database';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { importMaster, pgImportRepositories } from './import-master';
import { ImportInvalid, type ParsedMaster, parseMaster, type SourceReport } from './parse-master';
import { problemLines, reportLines } from './report';
import { findSources, readSources } from './sources';

const DIR = process.env.MASTER_DATA_DIR?.trim();

/** Runs one set-up step; a failure names the step and, for invalid data, every problem (no names from the file). */
async function step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const detail =
      error instanceof ImportInvalid
        ? `${error.message}\n${problemLines(error.problems).join('\n')}`
        : (error as Error).message;
    throw new Error(`${name} failed: ${detail}`, { cause: error });
  }
}

/**
 * The PO counts of the export of 21 Oct 2026, verified on that file (doc 02 §3.3, doc 08 T2.4). A newer export
 * changes them: check its report, then update these numbers and the docs together.
 */
const EXPECTED_POS: Omit<SourceReport['pos'], 'conflicts' | 'skipped' | 'unreadableDates'> = {
  rows: 34_230,
  duplicatesMerged: 3,
  conflictGroups: 91,
  conflictRows: 231,
  otherSkippedRows: 0,
  unique: 33_996,
};

(DIR ? describe : describe.skip)('import-master on the real exports (T2.4)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let parsed: ParsedMaster;

  beforeAll(async () => {
    const folder = resolve(process.env.INIT_CWD ?? process.cwd(), DIR!);
    const sources = await step('Finding the files', () => findSources(folder));
    const tables = await step('Reading the files', () => readSources(sources));
    parsed = await step('Checking the data', () => parseMaster(tables));
    process.stdout.write(`${reportLines(parsed.report).join('\n')}\n`);
    testDb = await step('Creating the test database', () => createTestDatabase({ migrated: true }));
    db = new Database(testDb.pool('m100_app'));
  }, 300_000);

  afterAll(async () => {
    await testDb?.drop();
  });

  // Counts and levels only, so a failure prints no name from the file.
  const levelsOf = (name: string) =>
    parsed.users.filter((u) => u.username === name).map((u) => u.level);

  it('finds 14 PSI logins: ROIS FATHUR ROHIM once, EVA JULIYANI as PSI lv.1 only', () => {
    expect(parsed.users.length).toBe(14);
    expect(levelsOf('ROIS FATHUR ROHIM').length).toBe(1);
    expect(levelsOf('EVA JULIYANI')).toEqual(['PSI lv.1']);
  });

  it('imports factories F 1 … F 5 only (no PWA, no BOTTOM)', () => {
    expect(parsed.factories).toEqual(['F 1', 'F 2', 'F 3', 'F 4', 'F 5']);
    expect(parsed.report.cells.otherFactories).toEqual(expect.arrayContaining(['PWA', 'BOTTOM']));
  });

  it('reads 98 defects and 437 map rows', () => {
    expect(parsed.defects).toHaveLength(98);
    expect(parsed.areaMap).toHaveLength(437);
  });

  it('accounts for every non-empty PO row', () => {
    const p = parsed.report.pos;
    expect(p.unique + p.duplicatesMerged + p.conflictRows + p.otherSkippedRows).toBe(p.rows);
    expect(parsed.pos).toHaveLength(p.unique);
  });

  it('a dry run writes nothing; the import writes everything; a second run changes nothing', async () => {
    const repos = pgImportRepositories(db);
    const dry = await importMaster(db, repos, parsed, { dryRun: true });
    expect(dry.tables.pos.inserted).toBe(parsed.report.pos.unique);
    const count = async () =>
      (await testDb.client.query<{ n: number }>('SELECT count(*)::int AS n FROM pos')).rows[0]!.n;
    expect(await count()).toBe(0);

    const first = await importMaster(db, repos, parsed, { dryRun: false });
    expect(first).toMatchObject({ changed: true, masterVersion: 1 });
    expect(await count()).toBe(parsed.report.pos.unique);

    const second = await importMaster(db, repos, parsed, { dryRun: false });
    expect(second).toMatchObject({ changed: false, masterVersion: 1 });
    for (const counts of Object.values(second.tables))
      expect(counts.inserted + counts.updated).toBe(0);
  }, 300_000);

  it('matches the verified PO counts of the fresh export', () => {
    const { rows, duplicatesMerged, conflictGroups, conflictRows, otherSkippedRows, unique } =
      parsed.report.pos;
    const counts = {
      rows,
      duplicatesMerged,
      conflictGroups,
      conflictRows,
      otherSkippedRows,
      unique,
    };
    expect(counts).toEqual(EXPECTED_POS);
  });
});
