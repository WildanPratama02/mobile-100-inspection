/**
 * The tablet's check for admin corrections (ADR-024, doc 03 §4.11, doc 04 §3.4). For the sent submissions still on
 * the tablet (Terkirim, 7 days after sending), each author's token asks `GET /submissions/corrections`; a newer
 * revision is stored with the photos the tablet does not hold yet, all in one Dexie transaction. A failed or
 * interrupted check writes nothing and is simply repeated next time. The outbox item, its `payloadJson` and its
 * photos never change, so a resend still matches byte for byte; Home and the open session are never touched.
 */
import { apiFetch, apiFetchBlob, type Fetch } from '../api/client';
import { ApiError } from '../data/sources';
import * as repo from '../db/repo';
import type {
  CorrectedSubmission,
  CorrectionPhotoRow,
  CorrectionRow,
  M100Db,
  OutboxRow,
} from '../db/schema';
import type { DefectId } from '@m100/shared';

/** Submission ids per request (doc 04 §7). */
export const CORRECTION_IDS_PER_REQUEST = 50;

/** One item of `GET /submissions/corrections` (`Correction` in `04-openapi.yaml`). */
interface CorrectionAnswer {
  submissionUuid: string;
  revisionNo: number;
  correctedAt: string;
  reason: string;
  submission: CorrectedSubmission;
  photos: Array<{ defectId: DefectId; sha256: string; sizeBytes: number }>;
}

export interface CorrectionCheckDeps {
  db: M100Db;
  deviceKey: () => string | null;
  fetch?: Fetch;
  now?: () => string;
  /** Hex SHA-256 of a blob; `crypto.subtle` by default. */
  sha256?: (blob: Blob) => Promise<string>;
  /** Called after a correction was stored, so the screens can show it. */
  onChange?: () => void;
}

export interface CorrectionChecker {
  /** One check; a call during a check waits for it and does not start another. Never rejects. */
  check: () => Promise<void>;
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function createCorrectionChecker(deps: CorrectionCheckDeps): CorrectionChecker {
  const { db, fetch: fetchImpl } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const hash = deps.sha256 ?? sha256Hex;
  let running: Promise<void> | null = null;

  /** Stores one answer, or nothing when a photo cannot be fetched or does not match. */
  async function store(
    item: OutboxRow,
    answer: CorrectionAnswer,
    deviceKey: string,
  ): Promise<boolean> {
    const known = new Map<string, string>();
    for (const p of await repo.listOutboxPhotos(db, item.submissionUuid))
      known.set(p.sha256, p.defectId);
    for (const p of await repo.listCorrectionPhotos(db, item.submissionUuid))
      known.set(p.sha256, p.defectId);
    const fetched: CorrectionPhotoRow[] = [];
    for (const photo of answer.photos) {
      if (known.has(photo.sha256)) continue;
      const blob = await apiFetchBlob(
        {
          path: `/submissions/${item.submissionUuid}/corrections/${answer.revisionNo}/photos/${photo.defectId}`,
          deviceKey,
          token: item.authorToken,
        },
        fetchImpl,
      );
      if ((await hash(blob)) !== photo.sha256) {
        console.warn(`Correction photo ${item.submissionUuid}/${photo.defectId}: SHA-256 differs`);
        return false;
      }
      fetched.push({
        submissionUuid: item.submissionUuid,
        defectId: photo.defectId,
        blob,
        sha256: photo.sha256,
      });
    }
    const row: CorrectionRow = {
      submissionUuid: item.submissionUuid,
      authorUsername: item.authorUsername,
      revisionNo: answer.revisionNo,
      correctedAt: answer.correctedAt,
      reason: answer.reason,
      submission: answer.submission,
      photos: answer.photos.map((p) => ({ defectId: p.defectId, sha256: p.sha256 })),
      checkedAt: now(),
    };
    await repo.saveCorrection(db, row, fetched);
    return true;
  }

  async function run(): Promise<void> {
    const deviceKey = deps.deviceKey();
    if (!deviceKey) return;
    const sent = (await db.outbox.where('state').equals('sent').toArray()).filter(
      (o) =>
        o.authorToken !== null &&
        o.sentAt !== null &&
        Date.parse(now()) - Date.parse(o.sentAt) < repo.SENT_KEPT_MS,
    );
    const byAuthor = new Map<string, OutboxRow[]>();
    for (const item of sent) {
      const list = byAuthor.get(item.authorUsername) ?? [];
      list.push(item);
      byAuthor.set(item.authorUsername, list);
    }
    let changed = false;
    for (const items of byAuthor.values()) {
      for (const batch of chunks(items, CORRECTION_IDS_PER_REQUEST)) {
        // The newest token of the author's items: the sender renews them one by one.
        const token = batch
          .map((o) => ({ token: o.authorToken, at: o.authorTokenExpiresAt ?? '' }))
          .sort((a, b) => b.at.localeCompare(a.at))[0]!.token;
        const ids = batch.map((o) => o.submissionUuid).join(',');
        const { body } = await apiFetch(
          { path: `/submissions/corrections?ids=${ids}`, deviceKey, token },
          fetchImpl,
        );
        const items = (body as { items?: CorrectionAnswer[] } | undefined)?.items ?? [];
        for (const answer of items) {
          const item = batch.find((o) => o.submissionUuid === answer.submissionUuid);
          if (!item) continue;
          const stored = await repo.getCorrection(db, item.submissionUuid);
          if (stored && stored.revisionNo >= answer.revisionNo) continue;
          try {
            if (await store({ ...item, authorToken: token }, answer, deviceKey)) changed = true;
          } catch (error) {
            // A photo of an older revision (404) or no connection: the next check starts over.
            if (!(error instanceof ApiError)) throw error;
            console.warn(`Correction ${item.submissionUuid}: ${error.code}`);
          }
        }
      }
    }
    if (changed) deps.onChange?.();
  }

  return {
    check: () => {
      running ??= run()
        .catch((error: unknown) => console.warn('Correction check failed', error))
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}
