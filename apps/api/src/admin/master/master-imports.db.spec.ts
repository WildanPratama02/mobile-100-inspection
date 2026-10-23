import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import writeExcelFile from 'write-excel-file/node';
import { configureApp } from '../../app';
import { AppModule } from '../../app.module';
import { Database } from '../../db/database';
import { importMaster, pgImportRepositories } from '../../import/import-master';
import { parseMaster } from '../../import/parse-master';
import {
  type CellValue,
  findReferenceMapping,
  MAPPING_SHEETS,
  type MappingSheet,
  readMapping,
} from '../../import/sources';
import { createTestDatabase, type TestDatabase } from '../../testing/database';
import { testConfig } from '../../testing/env';
import { fixtureTables } from '../../testing/master-fixtures';
import { expectMatchesSpec, expectProblem } from '../../testing/openapi';
import { createAdmin, pgAdminAccountRepositories } from '../admin-accounts';
import { UPLOAD_LIMIT } from '../upload';
import type { ImportReport } from './master-imports.service';

let testDb: TestDatabase;
let photoDir: string;
let app: NestExpressApplication;
let cookie: string;

const PASSWORD = 'a-strong-password-1';
const XRW = { 'X-Requested-With': 'm100-admin' };
const report = (res: request.Response) => res.body as ImportReport;
const HEADER = ['PO', 'ARTICLE', 'MODEL', 'DESTINATION', 'ORDER QTY', 'PODD', 'CRD'];

let counter = 0;
let ip = '';
beforeEach(() => {
  ++counter;
  ip = `10.3.${Math.floor(counter / 250)}.${counter % 250}`;
});

function upload(path: string, file: Buffer, name: string) {
  return request(app.getHttpServer())
    .post(`/v1${path}`)
    .set('X-Forwarded-For', ip)
    .set('Cookie', cookie)
    .set(XRW)
    .attach('file', file, name);
}

function csv(rows: CellValue[][]): Buffer {
  const cell = (v: CellValue) => {
    const text = v === null ? '' : String(v);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  // With a BOM, as Excel writes a UTF-8 CSV.
  const bom = String.fromCharCode(0xfeff);
  return Buffer.from(`${bom}${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`, 'utf8');
}

async function xlsx(sheets: { sheet: string; rows: CellValue[][] }[]): Promise<Buffer> {
  return writeExcelFile(
    sheets.map(({ sheet, rows }) => ({
      sheet,
      data: rows.map((row) =>
        row.map((v) => (v instanceof Date ? { value: v, format: 'yyyy-mm-dd' } : v)),
      ),
    })),
  ).toBuffer();
}

/** The reference mapping workbook as sheets of its required columns, changed by `change` first. */
async function mappingWorkbook(
  change: (sheets: Record<MappingSheet, CellValue[][]>) => void = () => undefined,
): Promise<Buffer> {
  const tables = await readMapping(findReferenceMapping());
  const sheets = Object.fromEntries(
    Object.entries(MAPPING_SHEETS).map(([sheet, columns]) => [
      sheet,
      [
        [...columns],
        ...tables[sheet as MappingSheet].rows.map((r) => columns.map((c) => r.cells[c]!)),
      ],
    ]),
  ) as Record<MappingSheet, CellValue[][]>;
  change(sheets);
  return xlsx(Object.entries(sheets).map(([sheet, rows]) => ({ sheet, rows })));
}

async function count(sql: string): Promise<number> {
  const { rows } = await testDb.client.query<{ n: number }>(`SELECT (${sql})::int AS n`);
  return rows[0]!.n;
}
const masterVersion = () => count(`SELECT value::int FROM settings WHERE key = 'master_version'`);

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: true });
  const db = new Database(testDb.pool('m100_app'));
  await importMaster(db, pgImportRepositories(db), parseMaster(await fixtureTables()), {
    dryRun: false,
  });
  await createAdmin(db, pgAdminAccountRepositories(db), {
    username: 'qip.digital',
    password: PASSWORD,
    actor: 'script:admin:create',
  });
  photoDir = mkdtempSync(join(tmpdir(), 'm100-master-imports-'));
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forConfig(
        testConfig({
          databaseUrl: testDb.url('m100_app'),
          photoStore: { kind: 'disk', dir: photoDir },
        }),
      ),
    ],
  }).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }));
  await app.init();
  const login = await request(app.getHttpServer())
    .post('/v1/admin/auth/login')
    .set(XRW)
    .set('X-Forwarded-For', '10.3.255.1')
    .send({ username: 'qip.digital', password: PASSWORD });
  expect(login.status).toBe(204);
  cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
  rmSync(photoDir, { recursive: true, force: true });
});

describe('POST /admin/pos/import (doc 04 §8, §10 A9)', () => {
  const file = () =>
    csv([
      HEADER,
      ['0908880001', 'NEW1', 'MODEL\u00a0ONE', 'JAPAN', 500, '2026-12-01', ''],
      ['0908880001', 'NEW1', 'MODEL\u00a0ONE', 'JAPAN', 500, '2026-12-01', ''],
      ['0902028839', 'CHANGED', 'RUNNER X', 'JAPAN', 10002, '2026-01-12', ''],
      ['CX-0902368685', 'IH5678', 'ULTRA', 'KOREA', 300, '2026-03-01', '2026-03-09'],
    ]);

  it('reports a dry run without writing, applies the same counts, and is idempotent', async () => {
    const version = await masterVersion();
    const pos = await count('SELECT count(*) FROM pos');
    const unchanged = await testDb.client.query<{ article: string; source: string }>(
      `SELECT article, source FROM pos WHERE po = 'CX-0902368685'`,
    );

    const dry = await upload('/admin/pos/import', file(), 'POS.csv');
    expectMatchesSpec(dry, 'post', '/admin/pos/import');
    const changedCx = unchanged.rows[0]!.article !== 'IH5678';
    expect(dry.body).toEqual({
      dryRun: true,
      read: 4,
      inserted: 1,
      updated: changedCx ? 2 : 1,
      skipped: changedCx ? 1 : 2,
      errors: [],
      warnings: [],
    });
    expect(await masterVersion()).toBe(version);
    expect(await count('SELECT count(*) FROM pos')).toBe(pos);

    const applied = await upload('/admin/pos/import?dryRun=false', file(), 'POS.csv');
    expectMatchesSpec(applied, 'post', '/admin/pos/import');
    expect(applied.body).toEqual({ ...dry.body, dryRun: false });
    expect(await masterVersion()).toBe(version + 1);
    expect(await count('SELECT count(*) FROM pos')).toBe(pos + 1);
    const { rows } = await testDb.client.query(
      `SELECT po, model, source FROM pos WHERE po IN ('0908880001', '0902028839') ORDER BY po`,
    );
    expect(rows).toEqual([
      { po: '0902028839', model: 'RUNNER X', source: 'import:POS.csv' },
      { po: '0908880001', model: 'MODEL\u00a0ONE', source: 'import:POS.csv' },
    ]);
    const { rows: audit } = await testDb.client.query(
      `SELECT actor, action, entity, details FROM audit_log WHERE entity = 'pos' AND action = 'import'`,
    );
    expect(audit).toEqual([
      {
        actor: 'admin:qip.digital',
        action: 'import',
        entity: 'pos',
        details: expect.objectContaining({
          file: 'POS.csv',
          read: 4,
          masterVersion: version + 1,
        }) as unknown,
      },
    ]);

    // Again: nothing changes, no version bump, never a delete.
    const again = await upload('/admin/pos/import?dryRun=false', file(), 'POS.csv');
    expect(again.body).toMatchObject({ inserted: 0, updated: 0, skipped: 4 });
    expect(await masterVersion()).toBe(version + 1);
    expect(await count('SELECT count(*) FROM pos')).toBe(pos + 1);
  });

  it('reads a workbook from its ALL_PO_MASTER sheet, else its first sheet', async () => {
    const rows = [HEADER, ['0908880002', 'X', 'Y', 'Z', 7, new Date('2026-12-24T00:00:00Z'), null]];
    const named = await xlsx([
      { sheet: 'Notes', rows: [['nothing here']] },
      { sheet: 'ALL_PO_MASTER', rows },
    ]);
    const dry = await upload('/admin/pos/import', named, 'export.xlsx');
    expect(dry.body).toMatchObject({ read: 1, inserted: 1, errors: [] });
    const first = await xlsx([{ sheet: 'Sheet1', rows }]);
    const applied = await upload('/admin/pos/import?dryRun=false', first, 'pos.xlsx');
    expect(applied.body).toMatchObject({ read: 1, inserted: 1 });
    const { rows: stored } = await testDb.client.query(
      `SELECT to_char(podd, 'YYYY-MM-DD') AS podd FROM pos WHERE po = '0908880002'`,
    );
    expect(stored).toEqual([{ podd: '2026-12-24' }]);
  });

  it('applies nothing when any row is invalid: the dry run lists every row, applying is 422 IMPORT_INVALID (AC-14.3)', async () => {
    const bad = csv([
      HEADER,
      ['0908880003', 'OK', 'OK', 'OK', 10, '', ''],
      ['', 'NO PO', '', '', 10, '', ''],
      ['0908880004', 'BAD QTY', '', '', 'ten', '', ''],
    ]);
    const version = await masterVersion();
    const dry = await upload('/admin/pos/import', bad, 'bad.csv');
    expectMatchesSpec(dry, 'post', '/admin/pos/import');
    expect(dry.body).toMatchObject({ dryRun: true, read: 3, inserted: 1 });
    expect(report(dry).errors).toEqual([
      { sheet: 'ALL_PO_MASTER', row: 3, code: 'PO_EMPTY', message: 'Kolom PO kosong.' },
      {
        sheet: 'ALL_PO_MASTER',
        row: 4,
        code: 'ORDER_QTY_INVALID',
        message: 'PO 0908880004: ORDER QTY "ten" bukan bilangan bulat ≥ 1.',
      },
    ]);

    const applied = await upload('/admin/pos/import?dryRun=false', bad, 'bad.csv');
    expectMatchesSpec(applied, 'post', '/admin/pos/import');
    const problem = expectProblem(applied, 422, 'IMPORT_INVALID');
    expect(problem.errors?.map((e) => [e.path, e.code])).toEqual([
      ['ALL_PO_MASTER baris 3', 'PO_EMPTY'],
      ['ALL_PO_MASTER baris 4', 'ORDER_QTY_INVALID'],
    ]);
    expect(await count(`SELECT count(*) FROM pos WHERE po = '0908880003'`)).toBe(0);
    expect(await masterVersion()).toBe(version);
  });

  it('refuses a file without a needed column, a body without a file, a bad dryRun and a file over 20 MB', async () => {
    const noColumn = await upload(
      '/admin/pos/import',
      csv([
        ['PO', 'ARTICLE'],
        ['1', 'A'],
      ]),
      'x.csv',
    );
    expect(expectProblem(noColumn, 422, 'IMPORT_INVALID').errors).toEqual([
      {
        path: 'file',
        code: 'FILE_INVALID',
        message: expect.stringContaining('no column MODEL') as string,
      },
    ]);
    const noFile = await request(app.getHttpServer())
      .post('/v1/admin/pos/import')
      .set('X-Forwarded-For', ip)
      .set('Cookie', cookie)
      .set(XRW)
      .field('other', 'x');
    expectProblem(noFile, 422, 'VALIDATION_FAILED');
    expectProblem(
      await upload('/admin/pos/import?dryRun=maybe', csv([HEADER]), 'x.csv'),
      422,
      'VALIDATION_FAILED',
    );
    const big = await upload('/admin/pos/import', Buffer.alloc(UPLOAD_LIMIT + 1, 0x41), 'big.csv');
    expectMatchesSpec(big, 'post', '/admin/pos/import');
    expectProblem(big, 413, 'PAYLOAD_TOO_LARGE');
  });
});

describe('POST /admin/area-map/import (doc 02 §5.1, doc 04 §10 A10)', () => {
  it('re-imports the reference workbook with nothing to change, dry run and applied', async () => {
    const workbook = readFileSync(findReferenceMapping());
    const version = await masterVersion();
    const dry = await upload(
      '/admin/area-map/import',
      workbook,
      'Footwear_Defect_Mapping_Database_v2.xlsx',
    );
    expectMatchesSpec(dry, 'post', '/admin/area-map/import');
    expect(dry.body).toMatchObject({
      dryRun: true,
      read: 437,
      inserted: 0,
      updated: 0,
      errors: [],
    });
    const applied = await upload(
      '/admin/area-map/import?dryRun=false',
      workbook,
      'Footwear_Defect_Mapping_Database_v2.xlsx',
    );
    expect(applied.body).toMatchObject({
      dryRun: false,
      inserted: 0,
      updated: 0,
      skipped: report(dry).skipped,
    });
    expect(await masterVersion()).toBe(version);
    expect(
      await count(`SELECT count(*) FROM audit_log WHERE entity = 'area_map' AND action = 'import'`),
    ).toBe(1);
  });

  it('refuses a new id that repeats a stored row, then applies a renamed sub-area and warns about a stored row left out', async () => {
    const version = await masterVersion();
    let removed = '';
    const workbook = await mappingWorkbook((sheets) => {
      const sub = sheets.SubArea_Master[1]!;
      sub[2] = `${String(sub[2])} (baru)`;
      const map = sheets.Defect_Area_Map;
      removed = String(map[1]![0]);
      // The first row under a fresh id: it repeats the stored row's sub-area, family and defect.
      map[1] = [`${removed}-X`, ...map[1]!.slice(1)];
    });
    // The new id repeats the stored row's sub-area, family and defect: refused as a whole.
    const clash = await upload('/admin/area-map/import?dryRun=false', workbook, 'map.xlsx');
    expect(expectProblem(clash, 422, 'IMPORT_INVALID').errors?.[0]).toMatchObject({
      code: 'CONSTRAINT',
    });
    expect(await masterVersion()).toBe(version);

    // Without that row, and with one sub-area renamed.
    const renamed = await mappingWorkbook((sheets) => {
      const sub = sheets.SubArea_Master[1]!;
      sub[2] = `${String(sub[2])} (baru)`;
      sheets.Defect_Area_Map.splice(1, 1);
    });
    const applied = await upload('/admin/area-map/import?dryRun=false', renamed, 'map.xlsx');
    expectMatchesSpec(applied, 'post', '/admin/area-map/import');
    expect(applied.body).toMatchObject({ inserted: 0, updated: 1, errors: [] });
    expect(report(applied).tables?.sub_areas).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: expect.any(Number) as number,
    });
    expect(report(applied).warnings).toEqual([
      `Defect_Area_Map: 1 baris ada di database tetapi tidak di workbook (${removed}); tidak diubah.`,
    ]);
    expect(await masterVersion()).toBe(version + 1);
    expect(await count(`SELECT count(*) FROM area_map WHERE id = '${removed}' AND active`)).toBe(1);
  });

  it('applies nothing when a defect is unknown or named differently than the stored defect', async () => {
    const version = await masterVersion();
    const workbook = await mappingWorkbook((sheets) => {
      sheets.Defect_Master[1]![1] = 'NOT THE STORED NAME';
      sheets.Defect_Area_Map[2]![1] = 'D999';
    });
    const dry = await upload('/admin/area-map/import', workbook, 'map.xlsx');
    expectMatchesSpec(dry, 'post', '/admin/area-map/import');
    expect(dry.body).toMatchObject({ dryRun: true, inserted: 0, updated: 0 });
    expect(report(dry).errors.map((e) => [e.sheet, e.message])).toEqual([
      ['Defect_Master', 'D001 is named differently than in defects'],
      ['Defect_Area_Map', expect.stringContaining('defect "D999" is not in Defect_Master')],
    ]);
    const applied = await upload('/admin/area-map/import?dryRun=false', workbook, 'map.xlsx');
    expectProblem(applied, 422, 'IMPORT_INVALID');
    expect(await masterVersion()).toBe(version);
    expectProblem(
      await upload('/admin/area-map/import', csv([HEADER]), 'not-a-workbook.csv'),
      422,
      'IMPORT_INVALID',
    );
  });
});
