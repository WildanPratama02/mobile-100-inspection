import type { AuthRow, OutboxRow } from '../src/db/schema';
import { expect, test } from './fixtures';
import { login } from './helpers';

test('sends a sealed legacy noDefect outbox fixture byte-for-byte and stores ADR-008', async ({
  page,
  sql,
  tablet,
}) => {
  await page.goto('/');
  await login(page, 'ANDI CONTOH');
  let received: string | undefined;
  await page.route('**/v1/submissions', async (route) => {
    const req = route.request();
    const form = await new Request('http://fixture/', {
      method: 'POST',
      headers: { 'Content-Type': (await req.headerValue('Content-Type'))! },
      body: new Uint8Array(req.postDataBuffer()!),
    }).formData();
    received = await (form.get('submission') as Blob).text();
    await route.continue();
  });
  const fixture = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('m100');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error!);
    });
    const auth = await new Promise<AuthRow>((resolve, reject) => {
      const req = db.transaction('auth').objectStore('auth').get('current');
      req.onsuccess = () => resolve(req.result as AuthRow);
      req.onerror = () => reject(req.error!);
    });
    const uuid = crypto.randomUUID();
    const at = new Date().toISOString();
    // This fixture represents bytes sealed by the old app. Preserve its original whitespace too.
    const payloadJson = JSON.stringify(
      {
        submissionUuid: uuid,
        sealedAt: at,
        appVersion: '1.0.0',
        user: { username: auth.username, level: auth.level },
        factory: auth.factory,
        cell: auth.cell,
        po: '0903359388',
        partial: null,
        counts: { rework: 0, bGrade: 0, noDefect: 2 },
        findings: [],
        photos: [],
      },
      null,
      2,
    );
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payloadJson));
    const hash = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join(
      '',
    );
    const row: OutboxRow = {
      submissionUuid: uuid,
      po: '0903359388',
      sealedAt: at,
      payloadJson,
      payloadSha256: hash,
      authorUsername: auth.username,
      authorToken: auth.token,
      authorTokenExpiresAt: auth.tokenExpiresAt,
      state: 'waiting',
      attempts: 0,
      nextAttemptAt: at,
      lastAttemptAt: null,
      problem: null,
      problemErrors: [],
      displayNo: null,
      sentAt: null,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').add(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error!);
    });
    db.close();
    return { uuid, payloadJson, hash };
  });
  await page.reload();
  await expect
    .poll(
      async () =>
        (
          await sql(
            "SELECT counting_rule, qty_inspection, qty_a_grade, qty_no_defect, encode(payload_sha256, 'hex') AS hash FROM submissions s JOIN devices d ON d.id = s.device_id WHERE s.id = $1 AND d.label = $2",
            [fixture.uuid, tablet.label],
          )
        ).rows,
    )
    .toEqual([
      {
        counting_rule: 'ADR-008',
        qty_inspection: 2,
        qty_a_grade: 2,
        qty_no_defect: 2,
        hash: fixture.hash,
      },
    ]);
  expect(received).toBe(fixture.payloadJson);
});
