import { setQtyInspection } from './helpers';
// SUBMIT PO end to end: the tablet app against the real API, test database and disk photo store started by global
// setup (T3.6: AC-03.7, AC-10.6, AC-11.1; doc 02 §4, §6, §7). Nothing is stubbed: what the PSI taps must arrive in
// `submissions`, `submission_findings`, `submission_photos` and `PHOTO_DIR`.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page } from '@playwright/test';
import { PHOTO_DIR_ENV } from './api/testApi';
import { expect, test, type Sql, type Tablet } from './fixtures';
import { addPo, bar, choice, login, openFamily, top5 } from './helpers';

const PO = '0903359388';
// Quarter › Medial / Lateral Quarter › Stitching (reference/mapping/mapping.json).
const D032 = 'WRONG STITCH LENGTH (not 9-10 stitches/inch)';
const D035 = 'BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM';
const D037 = 'WAVY/INCONSISTENT STITCHING';
const D039 = 'THREAD ENDS (>2mm)';
const D040 = 'WRONG THREAD OR WRONG COLOR';

interface SubmissionRow {
  id: string;
  payload_sha256: string;
  inspection_date: string;
  sealed_date: string;
  sealed_month: string;
  username: string;
  level: string;
  factory: string;
  cell: string;
  po: string;
  article: string;
  model: string;
  destination: string;
  order_qty: number;
  podd: string | null;
  crd: string | null;
  partial_no: number | null;
  partial_qty: number | null;
  partial_text: string | null;
  qty_rework: number;
  qty_bgrade_inspections: number;
  qty_no_defect: number | null;
  qty_inspection: number;
  qty_a_grade: number;
  qty_b_grade: number;
  qty_defect: number;
  rft: string;
  defect_rate: string;
  photo_count: number;
}

interface FindingRow {
  inspection_type: string;
  area_id: string;
  sub_area_id: string;
  family_id: string;
  defect_id: string;
  defect_name: string;
  severity: string;
  qty: number;
}

interface PhotoRow {
  defect_id: string;
  object_key: string;
  sha256: string;
  size_bytes: number;
}

/** The submissions this test's tablet wrote, oldest first; text columns as PostgreSQL prints them. */
async function submissions(sql: Sql, tablet: Tablet): Promise<SubmissionRow[]> {
  const { rows } = await sql<SubmissionRow>(
    `SELECT s.id, encode(s.payload_sha256, 'hex') AS payload_sha256, s.inspection_date::text AS inspection_date,
            (s.sealed_at AT TIME ZONE 'Asia/Jakarta')::date::text AS sealed_date,
            to_char(s.sealed_at AT TIME ZONE 'Asia/Jakarta', 'YYYY/MM') AS sealed_month,
            s.username, s.level, s.factory, s.cell, s.po, s.article, s.model, s.destination, s.order_qty,
            s.podd::text AS podd, s.crd::text AS crd, s.partial_no, s.partial_qty, v.partial_text,
            s.qty_rework, s.qty_bgrade_inspections, s.qty_no_defect, s.qty_inspection, s.qty_a_grade,
            s.qty_b_grade, s.qty_defect, s.rft::text AS rft, s.defect_rate::text AS defect_rate, s.photo_count
       FROM submissions s
       JOIN devices d ON d.id = s.device_id
       JOIN v_submissions v ON v.id = s.id
      WHERE d.label = $1
      ORDER BY s.display_no`,
    [tablet.label],
  );
  return rows;
}

async function findings(sql: Sql, submissionId: string): Promise<FindingRow[]> {
  const { rows } = await sql<FindingRow>(
    `SELECT inspection_type, area_id, sub_area_id, family_id, defect_id, defect_name, severity, qty
       FROM submission_findings WHERE submission_id = $1
      ORDER BY inspection_type, sub_area_id, defect_id`,
    [submissionId],
  );
  return rows;
}

async function photos(sql: Sql, submissionId: string): Promise<PhotoRow[]> {
  const { rows } = await sql<PhotoRow>(
    `SELECT defect_id, object_key, encode(sha256, 'hex') AS sha256, size_bytes
       FROM submission_photos WHERE submission_id = $1 ORDER BY defect_id`,
    [submissionId],
  );
  return rows;
}

/** Waits until the API has stored `count` submissions from this tablet. */
async function stored(sql: Sql, tablet: Tablet, count: number): Promise<SubmissionRow[]> {
  await expect
    .poll(async () => (await submissions(sql, tablet)).length, { timeout: 30_000 })
    .toBe(count);
  return submissions(sql, tablet);
}

/** `defectId → sha256` of the photos the tablet holds for its open sessions: the bytes it will send. */
function tabletPhotos(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('m100');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
    const rows = await new Promise<Array<{ defectId: string; sha256: string }>>(
      (resolve, reject) => {
        const request = db.transaction('photos').objectStore('photos').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      },
    );
    db.close();
    return Object.fromEntries(rows.map((r) => [r.defectId, r.sha256]));
  });
}

/** The outbox rows in IndexedDB with the fields the API keys a submission by. */
function outboxRows(
  page: Page,
): Promise<Array<{ submissionUuid: string; payloadSha256: string; state: string }>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('m100');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
    const rows = await new Promise<
      Array<{ submissionUuid: string; payloadSha256: string; state: string }>
    >((resolve, reject) => {
      const request = db.transaction('outbox').objectStore('outbox').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
    db.close();
    return rows.map(({ submissionUuid, payloadSha256, state }) => ({
      submissionUuid,
      payloadSha256,
      state,
    }));
  });
}

function photoDir(): string {
  const dir = process.env[PHOTO_DIR_ENV];
  if (!dir) throw new Error(`${PHOTO_DIR_ENV} is not set: global setup did not start the API`);
  return dir;
}

/** The file of a photo key in the disk store. */
const photoFile = (key: string) => join(photoDir(), ...key.split('/'));

async function tapDefect(page: Page, name: string, qty = 1) {
  await choice(page, name).click();
  await expect(choice(page, name)).toContainText(String(qty));
}

/** ADD DEFECT, one inspection of `type` with the defects of `taps` in Quarter › Stitching, END, back on Home. */
async function inspect(
  page: Page,
  type: 'REWORK' | 'B-GRADE',
  taps: Array<[subArea: 'Medial Quarter' | 'Lateral Quarter', defect: string]>,
) {
  await page.getByRole('button', { name: 'ADD DEFECT' }).click();
  await page.getByRole('button', { name: type }).click();
  let at: string | undefined;
  for (const [subArea, defect] of taps) {
    if (at === undefined) {
      await openFamily(page, 'QUARTER', subArea, 'Stitching');
    } else if (at !== subArea) {
      // Up to the sub-areas: defects › families › sub-areas.
      await bar(page, 'BACK').click();
      await bar(page, 'BACK').click();
      await choice(page, subArea).click();
      await choice(page, 'Stitching').click();
    }
    at = subArea;
    await tapDefect(page, defect);
  }
  await page.getByRole('button', { name: 'END INSPECTION' }).click();
  await bar(page, 'HOME').click();
}

async function enterInspection(page: Page) {
  await setQtyInspection(page, 30);
}

/** Takes a photo for the first Top 5 row that still needs one, as the system camera hands it over. */
async function shootNext(page: Page, colour: string) {
  const jpeg = await page.evaluate((fill) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 900;
    const context = canvas.getContext('2d')!;
    context.fillStyle = fill;
    context.fillRect(0, 0, 1200, 900);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
  }, colour);
  const required = top5(page).getByRole('button', { name: 'Foto wajib' });
  const before = await required.count();
  const chooser = page.waitForEvent('filechooser');
  await required.first().click();
  await (
    await chooser
  ).setFiles({ name: 'camera.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') });
  await expect(required).toHaveCount(before - 1);
}

/** SUBMIT PO → KIRIM, then waits until the tablet lists the item as Terkirim. */
async function submit(page: Page, sent: number) {
  await page.getByRole('button', { name: 'SUBMIT PO' }).click();
  await page
    .getByRole('dialog', { name: 'Submit PO' })
    .getByRole('button', { name: 'KIRIM' })
    .click();
  await expect
    .poll(async () => (await outboxRows(page)).filter((o) => o.state === 'sent').length, {
      timeout: 30_000,
    })
    .toBe(sent);
}

test('PSI lv.2 with five Top 5 photos: submission, findings and photo files (AC-11.1)', async ({
  page,
  sql,
  tablet,
}) => {
  await page.goto('/');
  await login(page, 'DEWI CONTOH');
  await addPo(page, PO);

  await inspect(page, 'REWORK', [
    ['Medial Quarter', D035],
    ['Medial Quarter', D037],
  ]);
  await inspect(page, 'B-GRADE', [
    ['Medial Quarter', D035],
    ['Lateral Quarter', D039],
  ]);
  await enterInspection(page);
  await enterInspection(page);
  await inspect(page, 'REWORK', [
    ['Medial Quarter', D032],
    ['Medial Quarter', D040],
  ]);

  // Five distinct defects: all five are in the Top 5 and each needs a photo (BR-04).
  await expect(top5(page).getByRole('listitem')).toHaveCount(5);
  for (const colour of ['teal', 'navy', 'maroon', 'olive', 'purple']) await shootNext(page, colour);
  const taken = await tabletPhotos(page);
  expect(Object.keys(taken).sort()).toEqual(['D032', 'D035', 'D037', 'D039', 'D040']);

  await submit(page, 1);
  const [row, ...more] = await stored(sql, tablet, 1);
  expect(more).toEqual([]);
  const [item] = await outboxRows(page);
  expect(row).toMatchObject({
    id: item!.submissionUuid,
    payload_sha256: item!.payloadSha256,
    inspection_date: row!.sealed_date,
    username: 'DEWI CONTOH',
    level: 'PSI lv.2',
    factory: 'F 3',
    cell: 'F3-10',
    // Snapshot of ALL_PO_MASTER (apps/web/src/data/fixtures/pos.ts).
    po: PO,
    article: 'IH0001',
    model: 'RUNNER CONTOH 1',
    destination: 'JAPAN',
    order_qty: 10002,
    podd: '2026-11-02',
    crd: '2026-11-20',
    partial_no: null,
    partial_qty: null,
    partial_text: null,
    // ADR-019: Qty Inspection 30, six findings, two of them during B-GRADE.
    qty_rework: 2,
    qty_bgrade_inspections: 1,
    qty_no_defect: null,
    qty_inspection: 30,
    qty_a_grade: 24,
    qty_b_grade: 2,
    qty_defect: 6,
    rft: '0.80000',
    defect_rate: '0.20000',
    photo_count: 5,
  });

  // One row per inspection type + area + sub-area + defect; names and severity from the mapping.
  const stitching = { area_id: 'A03', family_id: 'F03', qty: 1 };
  expect(await findings(sql, row!.id)).toEqual([
    {
      ...stitching,
      inspection_type: 'B-GRADE',
      sub_area_id: 'SA03L',
      defect_id: 'D039',
      defect_name: D039,
      severity: 'MINOR',
    },
    {
      ...stitching,
      inspection_type: 'B-GRADE',
      sub_area_id: 'SA03M',
      defect_id: 'D035',
      defect_name: D035,
      severity: 'MAJOR',
    },
    {
      ...stitching,
      inspection_type: 'REWORK',
      sub_area_id: 'SA03M',
      defect_id: 'D032',
      defect_name: D032,
      severity: 'MINOR',
    },
    {
      ...stitching,
      inspection_type: 'REWORK',
      sub_area_id: 'SA03M',
      defect_id: 'D035',
      defect_name: D035,
      severity: 'MAJOR',
    },
    {
      ...stitching,
      inspection_type: 'REWORK',
      sub_area_id: 'SA03M',
      defect_id: 'D037',
      defect_name: D037,
      severity: 'MINOR',
    },
    {
      ...stitching,
      inspection_type: 'REWORK',
      sub_area_id: 'SA03M',
      defect_id: 'D040',
      defect_name: D040,
      severity: 'MAJOR',
    },
  ]);

  // One photo per Top 5 defect under submissions/<yyyy>/<MM>/<uuid>/ (WIB month), stored byte for byte as the
  // tablet took it (doc 02 §7).
  const stored5 = await photos(sql, row!.id);
  expect(stored5.map((p) => p.defect_id)).toEqual(['D032', 'D035', 'D037', 'D039', 'D040']);
  for (const photo of stored5) {
    expect(photo.object_key).toBe(
      `submissions/${row!.sealed_month}/${row!.id}/${photo.defect_id}.jpg`,
    );
    const bytes = readFileSync(photoFile(photo.object_key));
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(bytes.length).toBe(photo.size_bytes);
    expect(bytes.length).toBeLessThanOrEqual(1024 * 1024);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(sha256).toBe(photo.sha256);
    expect(sha256).toBe(taken[photo.defect_id]);
  }
  const folder = join(photoDir(), 'submissions', ...row!.sealed_month.split('/'), row!.id);
  expect(readdirSync(folder).sort()).toEqual(stored5.map((p) => `${p.defect_id}.jpg`));
});

test('PSI lv.1: the submission has no photos (AC-10.6)', async ({ page, sql, tablet }) => {
  await page.goto('/');
  await login(page, 'ANDI CONTOH');
  await addPo(page, PO);
  await inspect(page, 'REWORK', [['Medial Quarter', D035]]);
  await enterInspection(page);
  await expect(top5(page).getByRole('button', { name: 'Foto wajib' })).toHaveCount(0);

  await submit(page, 1);
  const [row] = await stored(sql, tablet, 1);
  expect(row).toMatchObject({
    username: 'ANDI CONTOH',
    level: 'PSI lv.1',
    qty_inspection: 30,
    qty_defect: 1,
    qty_a_grade: 29,
    photo_count: 0,
  });
  expect(await findings(sql, row!.id)).toHaveLength(1);
  expect(await photos(sql, row!.id)).toEqual([]);
  expect(
    existsSync(join(photoDir(), 'submissions', ...row!.sealed_month.split('/'), row!.id)),
  ).toBe(false);
});

test('PO PARTIAL on, kept, then off: each submission stores the partial of that moment (AC-03.7)', async ({
  page,
  sql,
  tablet,
}) => {
  await page.goto('/');
  // PSI lv.1: no photo step between the submissions.
  await login(page, 'ANDI CONTOH');
  await page.getByRole('button', { name: 'Tambah PO' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tambah PO' });
  await dialog.getByRole('button', { name: /^PO NUMBER/ }).click();
  await dialog.getByRole('searchbox').fill(PO);
  await dialog.getByRole('option', { name: new RegExp(`^${PO}`) }).click();
  await dialog.getByRole('checkbox', { name: /PO PARTIAL/ }).click();
  await dialog
    .getByRole('group', { name: 'Partial ke' })
    .getByRole('button', { name: 'Tambah' })
    .click();
  const keys = dialog.getByRole('group', { name: 'Qty partial' });
  for (const d of '1200') await keys.getByRole('button', { name: d, exact: true }).click();
  await dialog.getByRole('button', { name: 'ADD TO PO LIST' }).click();
  const info = page.getByLabel('Info PO');
  await expect(info).toContainText('P2 · 1.200 dari 10.002');

  // On: the first submission carries P2 1.200.
  await enterInspection(page);
  await submit(page, 1);
  // Unchanged: every Submit PO for the PO writes it again (ADR-013).
  await expect(info).toContainText('P2 · 1.200 dari 10.002');
  await enterInspection(page);
  await submit(page, 2);

  // Off: UBAH PARTIAL, untick, SIMPAN.
  await page.getByRole('button', { name: 'UBAH PARTIAL' }).click();
  const partial = page.getByRole('dialog', { name: 'PO Partial' });
  await partial.getByRole('checkbox', { name: /PO PARTIAL/ }).click();
  await partial.getByRole('button', { name: 'SIMPAN' }).click();
  await expect(info).not.toContainText('dari 10.002');
  await enterInspection(page);
  await submit(page, 3);

  const rows = await stored(sql, tablet, 3);
  expect(rows.map((r) => [r.partial_no, r.partial_qty, r.partial_text])).toEqual([
    [2, 1200, 'P2 1.200 OF 10.002'],
    [2, 1200, 'P2 1.200 OF 10.002'],
    [null, null, null],
  ]);
});
