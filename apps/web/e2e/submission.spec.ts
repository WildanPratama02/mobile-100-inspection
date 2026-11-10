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
import { addPo, bar, choice, login, openFamily, tapNoDefect, allDefect } from './helpers';

const PO = '0903359388';
// Quarter › Medial / Lateral Quarter › Stitching (reference/mapping/mapping.json).
const D032 = 'WRONG STITCH LENGTH (not 9-10 stitches/inch)';
const D033 = 'WRONG ZIG-ZAG STITCH LENGTH (not 8 stitches/inch)';
const D035 = 'BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM';
const D036 = 'INSECURE BACK/LOCK-STITCH';
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

/** Takes a photo for the first ALL DEFECT row that still needs one, as the system camera hands it over. */
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
  const required = allDefect(page).getByRole('button', { name: 'Foto wajib' });
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

test('PSI lv.2 with five defect photos: submission, findings and photo files (AC-11.1)', async ({
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
  // PSI lv.2 counts pairs with taps (ADR-021): 7 NO DEFECT + 3 inspections.
  await tapNoDefect(page, 7);
  await inspect(page, 'REWORK', [
    ['Medial Quarter', D032],
    ['Medial Quarter', D040],
  ]);

  // Five distinct defects: each needs a photo (BR-04, ADR-022).
  await expect(allDefect(page).getByRole('listitem')).toHaveCount(5);
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
    // ADR-021: tapped counts, calculated as ADR-008. 10 pairs, 7 NO DEFECT, six findings, two during B-GRADE.
    qty_rework: 2,
    qty_bgrade_inspections: 1,
    qty_no_defect: 7,
    qty_inspection: 10,
    qty_a_grade: 7,
    qty_b_grade: 2,
    qty_defect: 6,
    rft: '0.70000',
    defect_rate: '0.60000',
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

  // One photo per defect under submissions/<yyyy>/<MM>/<uuid>/ (WIB month), stored byte for byte as the
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
    // The tablet resizes to at most 500 KB (AC-10.1, ADR-022 decision 3).
    expect(bytes.length).toBeLessThanOrEqual(500_000);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(sha256).toBe(photo.sha256);
    expect(sha256).toBe(taken[photo.defect_id]);
  }
  const folder = join(photoDir(), 'submissions', ...row!.sealed_month.split('/'), row!.id);
  expect(readdirSync(folder).sort()).toEqual(stored5.map((p) => `${p.defect_id}.jpg`));
});

/** The REWORK AND APPROVED row on Home, its value as shown. */
const approvedValue = (page: Page) =>
  page
    .getByRole('region', { name: 'Hasil' })
    .getByRole('button', { name: 'Ubah REWORK AND APPROVED' })
    .locator('b');

test('PSI lv.2 with seven defects needs seven photos; REWORK AND APPROVED is entered, sent and shown (ADR-022)', async ({
  page,
  sql,
  tablet,
}) => {
  await page.goto('/');
  await login(page, 'DEWI CONTOH');
  await addPo(page, PO);

  // Three REWORK inspections with seven distinct defects, and two NO DEFECT pairs: Qty Inspection 5.
  await inspect(page, 'REWORK', [
    ['Medial Quarter', D032],
    ['Medial Quarter', D033],
    ['Medial Quarter', D035],
  ]);
  await inspect(page, 'REWORK', [
    ['Medial Quarter', D036],
    ['Medial Quarter', D037],
  ]);
  await inspect(page, 'REWORK', [
    ['Medial Quarter', D039],
    ['Medial Quarter', D040],
  ]);
  await tapNoDefect(page, 2);

  // ALL DEFECT lists all seven, each needing its photo (FR-05, BR-04).
  await expect(allDefect(page).getByRole('listitem')).toHaveCount(7);
  await expect(allDefect(page).getByRole('button', { name: 'Foto wajib' })).toHaveCount(7);
  await expect(allDefect(page)).toContainText('7 foto belum ada.');

  // REWORK AND APPROVED (S5c): at most INSPECTION REWORK QTY 3.
  const results = page.getByRole('region', { name: 'Hasil' });
  await expect(
    results.locator('.m100-stat', {
      has: page.getByText('INSPECTION REWORK QTY', { exact: true }),
    }),
  ).toContainText('3');
  await results.getByRole('button', { name: 'Ubah REWORK AND APPROVED' }).click();
  const s5c = page.getByRole('dialog', { name: 'REWORK AND APPROVED' });
  await expect(s5c).toContainText(
    'Pasang rework yang sudah diperbaiki dan lolos inspeksi ulang (maks. 3)',
  );
  await s5c.getByRole('button', { name: '4', exact: true }).click();
  await expect(s5c).toContainText('Maksimum 3 pasang');
  await expect(s5c.getByRole('button', { name: 'SIMPAN' })).toBeDisabled();
  await s5c.getByRole('button', { name: 'HAPUS', exact: true }).click();
  await s5c.getByRole('button', { name: '2', exact: true }).click();
  await s5c.getByRole('button', { name: 'SIMPAN' }).click();
  await expect(s5c).toHaveCount(0);
  await expect(approvedValue(page)).toHaveText('2');
  // Saved on the tablet: a reload shows it again (NFR-03, NFR-05).
  await page.reload();
  await expect(approvedValue(page)).toHaveText('2');

  // Six photos are not enough: SUBMIT PO names the seventh defect.
  for (const colour of ['teal', 'navy', 'maroon', 'olive', 'purple', 'gray']) {
    await shootNext(page, colour);
  }
  await page.getByRole('button', { name: 'SUBMIT PO' }).click();
  const missing = page.getByRole('alertdialog', { name: 'Foto belum lengkap' });
  await expect(missing.getByRole('listitem')).toHaveCount(1);
  await missing.getByRole('button', { name: 'Lengkapi foto' }).click();
  await expect(missing).toHaveCount(0);
  await shootNext(page, 'black');
  await expect(allDefect(page)).not.toContainText('foto belum ada');

  // The confirmation shows both rework figures; the request carries counts.reworkApproved. The request goes on
  // to the real API; the route only reads its body.
  const bodies: string[] = [];
  await page.route('**/v1/submissions', async (route) => {
    bodies.push(route.request().postDataBuffer()?.toString('utf8') ?? '');
    await route.continue();
  });
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/v1/submissions',
  );
  await page.getByRole('button', { name: 'SUBMIT PO' }).click();
  const confirm = page.getByRole('dialog', { name: 'Submit PO' });
  await expect(
    confirm.locator('.m100-stat', { has: page.getByText('REWORK AND APPROVED', { exact: true }) }),
  ).toContainText('2');
  await expect(
    confirm.locator('.m100-stat', { has: page.getByText('Foto', { exact: true }) }),
  ).toContainText('7');
  await confirm.getByRole('button', { name: 'KIRIM' }).click();
  expect((await response).status()).toBe(201);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain('"reworkApproved":2');
  expect(bodies[0]).toContain('"photoRule":"ALL"');

  const [row] = await stored(sql, tablet, 1);
  expect(row).toMatchObject({ qty_rework: 3, qty_inspection: 5, qty_defect: 7, photo_count: 7 });
  const { rows } = await sql<{ qty_rework_approved: number; photo_rule: string }>(
    'SELECT qty_rework_approved, photo_rule FROM submissions WHERE id = $1',
    [row!.id],
  );
  expect(rows).toEqual([{ qty_rework_approved: 2, photo_rule: 'ALL' }]);
  expect((await photos(sql, row!.id)).map((p) => p.defect_id)).toEqual([
    'D032',
    'D033',
    'D035',
    'D036',
    'D037',
    'D039',
    'D040',
  ]);

  // The PO starts a new empty session: no rework, nothing to approve (AC-04.2).
  await expect(results.getByRole('button', { name: 'Ubah REWORK AND APPROVED' })).toHaveCount(0);
  await expect(results).toContainText('Belum ada inspeksi REWORK.');
});

test('PSI lv.1: the submission has no photos (AC-10.6)', async ({ page, sql, tablet }) => {
  await page.goto('/');
  await login(page, 'ANDI CONTOH');
  await addPo(page, PO);
  await inspect(page, 'REWORK', [['Medial Quarter', D035]]);
  await enterInspection(page);
  await expect(allDefect(page).getByRole('button', { name: 'Foto wajib' })).toHaveCount(0);

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
