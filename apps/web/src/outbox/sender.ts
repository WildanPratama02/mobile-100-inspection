/**
 * The outbox sender (doc 03 §4.6, doc 04 §5): sends sealed submissions to `POST /submissions`, oldest first, one at
 * a time, and follows the doc 04 §5 table exactly. It runs only while the app is open; `useOutboxSender` decides
 * when. Every item is sent with its author's token, so a submission sealed by PSI A goes as A after B has logged in
 * (doc 03 §4.4), and always with the stored `payloadJson` byte for byte, so a resend after a timeout is answered
 * `200` (doc 04 §4.3).
 *
 * Two cases doc 04 §5 leaves open: a second `401 TOKEN_EXPIRED` right after renewing and resending waits with the
 * back-off (the data is not invalid); any other refused answer (`4xx` outside the table, which the API does not
 * send) is Gagal like `422`, so it is never resent automatically.
 */
import { computeTotals, type SubmissionRequest } from '@m100/shared';
import { apiFetch, type Fetch } from '../api/client';
import { ApiError, OfflineError } from '../data/sources';
import * as repo from '../db/repo';
import type { Auth, M100Db, OutboxRow, OutboxState } from '../db/schema';

/** Waits after the 1st, 2nd, 3rd, 4th failed attempt, then every 5 min (doc 04 §5). */
export const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;

/** Shown for `401 DEVICE_KEY_INVALID` / `TOKEN_INVALID` (doc 04 §5, doc 05 §15). */
export const NOT_REGISTERED = 'Tablet belum terdaftar, hubungi admin';

/** The author's token is renewed when fewer than 7 days of its 30 remain (doc 04 §2). */
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

export interface OutboxSenderDeps {
  db: M100Db;
  /** The tablet's key; nothing is sent without one. */
  deviceKey: () => string | null;
  /** `POST /auth/refresh` with the given token. */
  refresh: (token: string) => Promise<Pick<Auth, 'token' | 'tokenExpiresAt'>>;
  fetch?: Fetch;
  now?: () => string;
  /** Called after every write to the outbox, so the screens can show it (AC-11.3). */
  onChange?: () => void;
}

export interface OutboxSender {
  /**
   * One pass over the items that may be tried now; with `force`, every Menunggu item (app start, connection back).
   * A call during a pass queues one more pass; the promise resolves when that pass has ended.
   */
  run: (options?: { force?: boolean }) => Promise<void>;
  /** At app start: items left Mengirim by a closed app are Menunggu again, then all are tried (doc 04 §5). */
  start: () => Promise<void>;
  /** A pass right after KIRIM; resolves to the item as that pass left it. */
  send: (submissionUuid: string) => Promise<OutboxRow | undefined>;
}

/** Back-off for the n-th failed attempt (1-based). */
export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]!;
}

const later = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();

/** The parts of `POST /submissions` (doc 04 §4.1): the stored JSON string and one JPEG per `photos[]` entry. */
export function submissionForm(
  item: Pick<OutboxRow, 'payloadJson'>,
  photos: ReadonlyArray<{ defectId: string; blob: Blob }>,
): FormData {
  const form = new FormData();
  form.append('submission', new Blob([item.payloadJson], { type: 'application/json' }));
  const byDefect = new Map(photos.map((p) => [p.defectId, p]));
  const { photos: entries } = JSON.parse(item.payloadJson) as Pick<SubmissionRequest, 'photos'>;
  for (const { defectId, part } of entries) {
    const photo = byDefect.get(defectId);
    // A missing photo is not invented: the API answers PHOTO_MISSING and the item shows Gagal.
    if (photo) form.append(part, new Blob([photo.blob], { type: 'image/jpeg' }), `${defectId}.jpg`);
  }
  return form;
}

type Outcome = Partial<Omit<OutboxRow, 'submissionUuid'>> & { state: OutboxState };

export function createOutboxSender(deps: OutboxSenderDeps): OutboxSender {
  const { db, refresh, fetch: fetchImpl } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const changed = () => deps.onChange?.();

  async function update(item: OutboxRow, patch: Partial<OutboxRow>): Promise<OutboxRow> {
    const stored = await repo.updateOutboxItem(db, item.submissionUuid, patch);
    changed();
    return stored ?? { ...item, ...patch };
  }

  function waiting(attempts: number, retryAfter: number | null = null): Outcome {
    const delay = retryAfter === null ? backoffMs(attempts) : retryAfter * 1000;
    return { state: 'waiting', nextAttemptAt: later(now(), delay) };
  }

  /** The doc 04 §5 row for an answer other than `200`/`201`. */
  function outcomeOf(error: unknown, attempts: number): Outcome {
    if (error instanceof OfflineError) return waiting(attempts);
    if (!(error instanceof ApiError)) {
      console.error(error);
      return waiting(attempts);
    }
    if (error.code === 'DEVICE_KEY_INVALID' || error.code === 'TOKEN_INVALID') {
      return { state: 'failed', problem: NOT_REGISTERED, problemErrors: [] };
    }
    if (error.code === 'TOKEN_EXPIRED' || error.status === 429 || error.status >= 500) {
      return waiting(attempts, error.retryAfter);
    }
    return {
      state: 'failed',
      problem: error.detail,
      problemErrors: error.errors.map((e) => e.message),
    };
  }

  async function renew(item: OutboxRow, token: string): Promise<OutboxRow> {
    const renewed = await refresh(token);
    return update(item, {
      authorToken: renewed.token,
      authorTokenExpiresAt: renewed.tokenExpiresAt,
    });
  }

  async function post(item: OutboxRow, deviceKey: string): Promise<unknown> {
    const photos = await repo.listOutboxPhotos(db, item.submissionUuid);
    const { body } = await apiFetch(
      {
        method: 'POST',
        path: '/submissions',
        deviceKey,
        token: item.authorToken,
        form: submissionForm(item, photos),
      },
      fetchImpl,
    );
    return body;
  }

  /** The tablet logs a difference between its totals and the API's (doc 04 §4.1). */
  function compareTotals(item: OutboxRow, body: unknown): void {
    const answered = (body as { totals?: Record<string, unknown> } | undefined)?.totals;
    if (!answered) return;
    const { counts, findings } = JSON.parse(item.payloadJson) as SubmissionRequest;
    const shown = computeTotals(counts, findings);
    const keys = ['qtyInspection', 'qtyAGrade', 'qtyBGrade', 'qtyDefect'] as const;
    const differs = keys.filter((k) => answered[k] !== shown[k]);
    if (differs.length > 0) {
      console.warn(`Submission ${item.submissionUuid}: API totals differ in ${differs.join(', ')}`);
    }
  }

  /** One attempt at one item; resolves to its state afterwards. */
  async function attempt(first: OutboxRow, deviceKey: string): Promise<OutboxState> {
    let item = first;
    const attempts = item.attempts + 1;
    try {
      const { authorToken, authorTokenExpiresAt } = item;
      if (
        authorToken &&
        authorTokenExpiresAt &&
        Date.parse(authorTokenExpiresAt) - Date.parse(now()) < RENEW_BEFORE_MS
      ) {
        item = await renew(item, authorToken);
      }
    } catch (error) {
      // A failed early renewal is no reason not to send: the token is still valid.
      const outcome = outcomeOf(error, attempts);
      if (outcome.state === 'failed') {
        await update(item, { ...outcome, attempts, lastAttemptAt: now() });
        return 'failed';
      }
    }

    item = await update(item, { state: 'sending', attempts, lastAttemptAt: now() });
    let outcome: Outcome;
    try {
      let body: unknown;
      try {
        body = await post(item, deviceKey);
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'TOKEN_EXPIRED' && item.authorToken)) {
          throw error;
        }
        // Renew, then resend once (doc 04 §5).
        item = await renew(item, item.authorToken);
        body = await post(item, deviceKey);
      }
      const displayNo = (body as { displayNo?: unknown } | undefined)?.displayNo;
      outcome = {
        state: 'sent',
        displayNo: typeof displayNo === 'string' ? displayNo : null,
        sentAt: now(),
        problem: null,
        problemErrors: [],
      };
      compareTotals(item, body);
    } catch (error) {
      outcome = outcomeOf(error, attempts);
    }
    await update(item, outcome);
    return outcome.state;
  }

  async function pass(force: boolean): Promise<void> {
    const deviceKey = deps.deviceKey();
    if (!deviceKey) return;
    if ((await repo.purgeSentOutbox(db, now())).length > 0) changed();
    for (const item of await repo.nextOutboxItems(db, now(), force)) {
      // Without an answer for this one, the next would get none either; they wait for the next trigger.
      if ((await attempt(item, deviceKey)) === 'waiting') return;
    }
  }

  let chain: Promise<void> = Promise.resolve();
  let queued: { force: boolean; done: Promise<void> } | null = null;

  function run({ force = false }: { force?: boolean } = {}): Promise<void> {
    if (queued) {
      queued.force ||= force;
      return queued.done;
    }
    const entry: { force: boolean; done: Promise<void> } = { force, done: Promise.resolve() };
    entry.done = chain.then(() => {
      queued = null;
      return pass(entry.force);
    });
    queued = entry;
    chain = entry.done.catch((error: unknown) => console.error(error));
    return entry.done;
  }

  return {
    run,
    start: async () => {
      if ((await repo.resetSendingOutbox(db, now())).length > 0) changed();
      await run({ force: true });
    },
    send: async (submissionUuid) => {
      await run();
      return repo.getOutboxItem(db, submissionUuid);
    },
  };
}
