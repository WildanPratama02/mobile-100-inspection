/**
 * Test helper for the load and fault tests (T3.7): a simulated tablet that sends its sealed submissions to
 * `POST /v1/submissions` over real HTTP the way the tablet's outbox does (`apps/web/src/outbox/sender.ts`, doc 04
 * §5): oldest first, one at a time, the stored bytes byte for byte on every resend, a 60 s timeout, and the
 * back-off of doc 04 §5 (`Retry-After` when the answer carries one). Every attempt is recorded for the report.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { defaultMapping, type DefectId, type Finding, type SubmissionRequest } from '@m100/shared';
import { sha256Hex } from '../submissions/multipart';

/** Waits after the 1st, 2nd, 3rd, 4th failed attempt, then every 5 min (doc 04 §5, as `BACKOFF_MS` in the web). */
export const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;

/** The tablet gives up waiting for an answer after 60 s and resends later (doc 04 §5). */
export const TIMEOUT_MS = 60_000;

export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]!;
}

/** A sealed submission as the outbox holds it: the JSON string and one JPEG per `photos[]` entry. */
export interface SealedSubmission {
  submissionUuid: string;
  json: string;
  photos: ReadonlyArray<{ defectId: DefectId; part: string; jpeg: Buffer }>;
}

export interface Attempt {
  submissionUuid: string;
  /** 1-based. */
  attempt: number;
  /** Milliseconds since the epoch. */
  startedAt: number;
  latencyMs: number;
  /** HTTP status, or `null` without an answer (no connection, timeout). */
  status: number | null;
  /** The problem `code`, `TIMEOUT` or `NETWORK`; absent on `200`/`201`. */
  code?: string;
}

export type ItemState = 'sent' | 'failed';

export interface SentItem {
  submissionUuid: string;
  state: ItemState;
  /** When the outbox first tried it and when it was answered `201`/`200` (or refused). */
  firstAttemptAt: number;
  doneAt: number;
  attempts: number;
  displayNo?: string;
  /** The `status` field of the last answer for a sent item. */
  status?: number;
}

export interface TabletOptions {
  baseUrl: string;
  deviceKey: string;
  token: string;
  /** Oldest first. */
  outbox: SealedSubmission[];
  /** Sealed submissions that join the outbox while it runs, each at its time (ms since the epoch). */
  later?: ReadonlyArray<{ at: number; item: SealedSubmission }>;
  onAttempt?: (attempt: Attempt) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The multipart request of doc 04 §4.1, built like `submissionForm()` in the web app. */
export function submissionForm(item: SealedSubmission): FormData {
  const form = new FormData();
  form.append('submission', new Blob([item.json], { type: 'application/json' }));
  for (const photo of item.photos) {
    form.append(
      photo.part,
      new Blob([photo.jpeg], { type: 'image/jpeg' }),
      `${photo.defectId}.jpg`,
    );
  }
  return form;
}

/**
 * Runs one tablet's outbox until every item is sent or failed, and resolves to the items in the order they ended.
 * A waiting item blocks the ones behind it, as on the tablet (doc 03 §4.6).
 */
export async function runTablet(options: TabletOptions): Promise<SentItem[]> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const queue = [...options.outbox];
  const pending = [...(options.later ?? [])].sort((a, b) => a.at - b.at);
  const done: SentItem[] = [];

  while (queue.length > 0 || pending.length > 0) {
    if (queue.length === 0) {
      await sleep(Math.max(0, pending[0]!.at - now()));
    }
    while (pending.length > 0 && pending[0]!.at <= now()) queue.push(pending.shift()!.item);
    const item = queue[0];
    if (!item) continue;

    let attempts = 0;
    let firstAttemptAt = 0;
    for (;;) {
      attempts++;
      const startedAt = now();
      if (attempts === 1) firstAttemptAt = startedAt;
      const answer = await send(fetchImpl, options, item);
      const latencyMs = now() - startedAt;
      options.onAttempt?.({
        submissionUuid: item.submissionUuid,
        attempt: attempts,
        startedAt,
        latencyMs,
        status: answer.status,
        ...(answer.code === undefined ? {} : { code: answer.code }),
      });
      if (answer.status === 200 || answer.status === 201) {
        done.push({
          submissionUuid: item.submissionUuid,
          state: 'sent',
          firstAttemptAt,
          doneAt: now(),
          attempts,
          status: answer.status,
          ...(answer.displayNo === undefined ? {} : { displayNo: answer.displayNo }),
        });
        break;
      }
      if (answer.status !== null && answer.status !== 429 && answer.status < 500) {
        // Gagal: never resent automatically (doc 04 §5).
        done.push({
          submissionUuid: item.submissionUuid,
          state: 'failed',
          firstAttemptAt,
          doneAt: now(),
          attempts,
        });
        break;
      }
      await sleep(answer.retryAfter === null ? backoffMs(attempts) : answer.retryAfter * 1000);
      while (pending.length > 0 && pending[0]!.at <= now()) queue.push(pending.shift()!.item);
    }
    queue.shift();
  }
  return done;
}

interface Answer {
  status: number | null;
  code?: string;
  retryAfter: number | null;
  displayNo?: string;
}

async function send(
  fetchImpl: typeof fetch,
  options: TabletOptions,
  item: SealedSubmission,
): Promise<Answer> {
  let response: Response;
  try {
    response = await fetchImpl(`${options.baseUrl}/v1/submissions`, {
      method: 'POST',
      headers: { 'X-Device-Key': options.deviceKey, Authorization: `Bearer ${options.token}` },
      body: submissionForm(item),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = (error as { name?: string }).name === 'TimeoutError';
    return { status: null, code: timedOut ? 'TIMEOUT' : 'NETWORK', retryAfter: null };
  }
  let body: { code?: unknown; displayNo?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // An answer without JSON (a proxy's error page) is still an answer with a status.
  }
  const header = Number(response.headers.get('retry-after'));
  return {
    status: response.status,
    retryAfter: Number.isFinite(header) && header > 0 ? header : null,
    ...(typeof body.code === 'string' ? { code: body.code } : {}),
    ...(typeof body.displayNo === 'string' ? { displayNo: body.displayNo } : {}),
  };
}

const mapping = defaultMapping();

/** Five mapped defects, D049 among them (it shares its name with D071, ADR-009). */
const DEFECTS: readonly DefectId[] = [
  'D035',
  'D049',
  'D082',
  ...[...new Set(mapping.map.map((e) => e.defectId))]
    .filter((id) => !['D035', 'D049', 'D071', 'D082'].includes(id))
    .slice(0, 2),
];

/** A JPEG-signed part of `bytes` random bytes; the API checks the signature only (doc 03 §5.4). */
function jpeg(bytes: number): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    randomBytes(Math.max(0, bytes - 4)),
  ]);
}

/**
 * A PSI lv.2 submission of `TEST BUDI` on `F 1`/`F1-1` and PO `0902028839` (the fixture master data) with five
 * defects, all in the Top 5, and their five photos of `photoBytes` each.
 */
export function fiveDefectSubmission(photoBytes: number): SealedSubmission {
  const submissionUuid = randomUUID();
  const findings: Array<Omit<Finding, 'familyId'>> = DEFECTS.map((defectId, i) => {
    const entry = mapping.map.find((e) => e.defectId === defectId)!;
    return {
      inspectionType: i === 2 ? 'B-GRADE' : 'REWORK',
      areaId: entry.areaId,
      subAreaId: entry.subAreaId,
      defectId,
      qty: 5 - i,
      firstRecordedAt: `2026-10-16T13:00:0${String(i + 1)}.250+07:00`,
    };
  });
  const photos = DEFECTS.map((defectId) => ({
    defectId,
    part: `photo_${defectId}`,
    jpeg: jpeg(photoBytes),
  }));
  const body: Omit<SubmissionRequest, 'findings'> & { findings: typeof findings } = {
    submissionUuid,
    sealedAt: '2026-10-16T14:32:05.123+07:00',
    appVersion: '1.0.0',
    user: { username: 'TEST BUDI', level: 'PSI lv.2' },
    factory: 'F 1',
    cell: 'F1-1',
    // Qty Order 1.200: the 30 tapped pairs are within the maximum (ADR-021).
    po: 'CX-0902368685',
    partial: null,
    // 15 defects: 12 during REWORK, 3 during B-GRADE (one pair); 30 inspected.
    counts: { rework: 10, bGrade: 1, noDefect: 19 },
    findings,
    photos: photos.map((p) => ({ defectId: p.defectId, part: p.part, sha256: sha256Hex(p.jpeg) })),
  };
  return { submissionUuid, json: JSON.stringify(body), photos };
}
