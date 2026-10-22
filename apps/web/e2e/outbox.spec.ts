// The outbox sender against a stub of `POST /submissions` (T3.5: AC-11.1 … AC-11.4, doc 04 §5, doc 05 §13.3, §14).
// Login, master data and PO search use the real API; only the submission answers are scripted here. The real write
// of the submission is tested end to end in T3.6.
import { type BrowserContext, type Page, type Route } from '@playwright/test';
import { expect, test } from './fixtures';
import { addPo, bar, login, logout, outbox, toast } from './helpers';

const PO = '0903359388';

/** One request the stub received. */
interface Received {
  uuid: string;
  /** The `submission` part as received. */
  submission: string;
  /** `sub` of the bearer token: the author the request was sent as. */
  author: string;
  photoParts: string[];
}

type Reply = (route: Route) => Promise<void>;

const written: Reply = (route) =>
  route.fulfill({
    status: 201,
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'written',
      displayNo: 'M100-000001',
      writtenAt: '2026-10-16T14:32:06+07:00',
      totals: { qtyInspection: 1, qtyAGrade: 1, qtyBGrade: 0, qtyDefect: 0, rft: 1, defectRate: 0 },
    }),
  });

const problem =
  (status: number, body: object, headers: Record<string, string> = {}): Reply =>
  (route) =>
    route.fulfill({
      status,
      contentType: 'application/problem+json',
      headers,
      body: JSON.stringify(body),
    });

const noConnection: Reply = (route) => route.abort('internetdisconnected');

/** Stubs `POST /submissions` for the whole browser context (also pages opened later). */
async function stubSubmissions(context: BrowserContext) {
  const received: Received[] = [];
  let reply: Reply = noConnection;
  await context.route('**/v1/submissions', async (route) => {
    const request = route.request();
    const form = await new Request('http://stub/', {
      method: 'POST',
      headers: { 'Content-Type': (await request.headerValue('Content-Type')) ?? '' },
      body: new Uint8Array(request.postDataBuffer() ?? []),
    }).formData();
    const submission = await (form.get('submission') as Blob).text();
    const token = ((await request.headerValue('Authorization')) ?? '').replace(/^Bearer /, '');
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
      sub: string;
    };
    received.push({
      uuid: (JSON.parse(submission) as { submissionUuid: string }).submissionUuid,
      submission,
      author: claims.sub,
      photoParts: [...form.keys()].filter((k) => k !== 'submission'),
    });
    await reply(route);
  });
  return {
    received,
    answer(next: Reply) {
      reply = next;
    },
  };
}

/** Logs in, adds the PO and records one NO DEFECT (PSI lv.1: no photo step), back on Home. */
async function readyToSubmit(page: Page, name = 'ANDI CONTOH') {
  await page.goto('/');
  await login(page, name);
  await addPo(page, PO);
  await page.getByRole('button', { name: 'ADD DEFECT' }).click();
  await page.getByRole('button', { name: 'NO DEFECT' }).click();
  await expect(toast(page)).toHaveText('No Defect tercatat. A-Grade +1');
  await bar(page, 'HOME').click();
}

async function kirim(page: Page) {
  await page.getByRole('button', { name: 'SUBMIT PO' }).click();
  await page
    .getByRole('dialog', { name: 'Submit PO' })
    .getByRole('button', { name: 'KIRIM' })
    .click();
}

const badge = (page: Page) => page.getByLabel(/pengiriman menunggu/);

/** The gear menu's Pengiriman list; closed again with Escape. */
async function outboxList(page: Page) {
  await page.getByRole('button', { name: 'Pengaturan' }).click();
  return page
    .getByRole('dialog', { name: 'Pengaturan' })
    .getByRole('region', { name: 'Pengiriman' })
    .getByRole('listitem');
}

async function closeMenu(page: Page) {
  await page
    .getByRole('dialog', { name: 'Pengaturan' })
    .getByRole('button', { name: 'Tutup' })
    .click();
}

test('AC-11.1: KIRIM online sends the sealed bytes and shows "PO terkirim HH:mm"', async ({
  page,
}) => {
  const stub = await stubSubmissions(page.context());
  stub.answer(written);
  await readyToSubmit(page);
  await kirim(page);

  await expect(page.getByText(/^PO terkirim \d{2}:\d{2}$/)).toBeVisible();
  await expect(badge(page)).toHaveCount(0);
  const [item, ...rest] = await outbox(page);
  expect(rest).toEqual([]);
  expect(item).toMatchObject({ po: PO, state: 'sent' });
  // The JSON part is the stored string, byte for byte (doc 04 §4.3); PSI lv.1 sends no photo (AC-10.6).
  expect(stub.received).toHaveLength(1);
  expect(stub.received[0]).toMatchObject({
    submission: item!.payloadJson,
    author: 'ANDI CONTOH',
    photoParts: [],
  });
  await expect(await outboxList(page)).toContainText('Terkirim');
});

test('AC-11.2: Wi-Fi off → submit → close the app → Wi-Fi on → reopen: exactly one submission', async ({
  page,
}) => {
  const context = page.context();
  const stub = await stubSubmissions(context);
  stub.answer(written);
  await readyToSubmit(page);

  await context.setOffline(true);
  await kirim(page);
  await expect(page.getByText('Tersimpan. Menunggu koneksi.')).toBeVisible();
  await expect(badge(page)).toHaveText('1');
  await page.close();

  await context.setOffline(false);
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(reopened.getByRole('button', { name: 'SUBMIT PO' })).toBeVisible();
  await expect.poll(async () => (await outbox(reopened)).map((o) => o.state)).toEqual(['sent']);
  await expect(badge(reopened)).toHaveCount(0);
  // Nothing more goes out: the app has nothing left to send.
  await reopened.waitForTimeout(1000);
  expect(stub.received).toHaveLength(1);
});

test('AC-11.3: the header count and the gear list follow Menunggu, Mengirim and Terkirim', async ({
  page,
}) => {
  const stub = await stubSubmissions(page.context());
  stub.answer(problem(503, { code: 'DB_UNAVAILABLE', retryable: true }, { 'Retry-After': '600' }));
  await readyToSubmit(page);
  await kirim(page);
  await expect(page.getByText('Tersimpan. Menunggu koneksi.')).toBeVisible();
  await expect(badge(page)).toHaveText('1');
  let rows = await outboxList(page);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Menunggu');
  await expect(rows).toContainText(/Dicoba terakhir \d{2}:\d{2}/);
  await closeMenu(page);

  // The connection comes back: the item goes at once, and shows Mengirim while the answer is out.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  stub.answer(async (route) => {
    await held;
    await written(route);
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  rows = await outboxList(page);
  await expect(rows).toContainText('Mengirim');
  await expect(badge(page)).toHaveText('1');
  release();
  await expect(rows).toContainText('Terkirim');
  await closeMenu(page);
  await expect(badge(page)).toHaveCount(0);
  expect(stub.received).toHaveLength(2);
  expect(stub.received[1]!.submission).toBe(stub.received[0]!.submission);
});

test('AC-11.4: a refused submission stays as Gagal with its reason and is never resent', async ({
  page,
}) => {
  const stub = await stubSubmissions(page.context());
  stub.answer(
    problem(422, {
      code: 'PO_NOT_FOUND',
      retryable: false,
      detail: 'PO tidak ditemukan di master PO.',
      errors: [{ path: 'po', code: 'PO_NOT_FOUND', message: 'PO tidak ditemukan di master PO.' }],
    }),
  );
  await readyToSubmit(page);
  await kirim(page);
  await expect(page.getByText(`Pengiriman PO ${PO} gagal. Lihat Pengaturan.`)).toBeVisible();
  // Gagal is not waiting for the connection (U15).
  await expect(badge(page)).toHaveCount(0);
  const rows = await outboxList(page);
  await expect(rows).toContainText('Gagal');
  await expect(rows).toContainText('PO tidak ditemukan di master PO.');
  await expect(rows).toContainText('Hubungi admin dengan nomor PO ini.');
  await closeMenu(page);

  // Reopened and the connection back: still there, still Gagal, not sent again.
  stub.answer(written);
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(await outboxList(page)).toContainText('Gagal');
  await page.waitForTimeout(1000);
  expect(stub.received).toHaveLength(1);
  expect(await outbox(page)).toMatchObject([{ state: 'failed' }]);
});

test('two PSI on one tablet: A seals, logs out, B logs in; A’s submission is sent as A', async ({
  page,
}) => {
  const stub = await stubSubmissions(page.context());
  stub.answer(noConnection);
  await readyToSubmit(page, 'ANDI CONTOH');
  await kirim(page);
  await expect(page.getByText('Tersimpan. Menunggu koneksi.')).toBeVisible();
  await logout(page);

  await login(page, 'DEWI CONTOH');
  // U14: B sees neither the count nor the item of A.
  await expect(badge(page)).toHaveCount(0);
  await expect(await outboxList(page)).toHaveCount(0);
  await closeMenu(page);

  stub.answer(written);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await outbox(page)).map((o) => o.state)).toEqual(['sent']);
  const sent = stub.received.at(-1)!;
  expect(sent.author).toBe('ANDI CONTOH');
  expect((await outbox(page))[0]).toMatchObject({ authorUsername: 'ANDI CONTOH' });
  // Every attempt carried the same submission.
  expect(new Set(stub.received.map((r) => r.uuid)).size).toBe(1);
});
