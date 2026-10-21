/**
 * T2.6 acceptance on the real PO export (doc 08): the PO search over the full imported set answers with p95 under
 * 100 ms. Runs only when `MASTER_DATA_DIR` names the folder of the exports, like `import-master.real.db.spec.ts`;
 * prints timings only, no data from the files.
 */
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Database } from '../db/database';
import { importMaster, pgImportRepositories } from '../import/import-master';
import { parseMaster } from '../import/parse-master';
import { findSources, readSources } from '../import/sources';
import { PgPoRepository } from '../repositories/po.repository';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { PO_SEARCH } from './po.service';

const DIR = process.env.MASTER_DATA_DIR?.trim();
const SEARCHES = 500;
const WARM_UP = 20;

(DIR ? describe : describe.skip)('PO search on the real PO export (T2.6)', () => {
  let testDb: TestDatabase;
  let repo: PgPoRepository;
  let numbers: string[];

  beforeAll(async () => {
    const folder = resolve(process.env.INIT_CWD ?? process.cwd(), DIR!);
    const parsed = parseMaster(await readSources(findSources(folder)));
    testDb = await createTestDatabase({ migrated: true });
    const db = new Database(testDb.pool('m100_app'));
    await importMaster(db, pgImportRepositories(db), parsed, { dryRun: false });
    await testDb.client.query('ANALYZE pos');
    repo = new PgPoRepository(db);
    numbers = parsed.pos.map((p) => p.po);
  }, 300_000);

  afterAll(async () => {
    await testDb?.drop();
  });

  it(`answers ${SEARCHES} searches by the last 3–4 PO digits with p95 under 100 ms`, async () => {
    const times: number[] = [];
    for (let i = 0; i < WARM_UP + SEARCHES; i++) {
      const number = numbers[(i * 7919) % numbers.length]!;
      const q = number.slice(-(3 + (i % 2)));
      const started = performance.now();
      const found = await repo.search(q, PO_SEARCH.maxResults);
      const ms = performance.now() - started;
      expect(found.length).toBeGreaterThan(0);
      if (i >= WARM_UP) times.push(ms);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    const p50 = times[Math.ceil(times.length * 0.5) - 1]!;
    process.stdout.write(
      `PO search over ${numbers.length} real POs: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms\n`,
    );
    expect(p95).toBeLessThan(100);
  }, 120_000);
});
