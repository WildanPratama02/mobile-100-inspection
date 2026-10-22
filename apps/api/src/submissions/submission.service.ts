/**
 * The Submit PO procedure (doc 02 §6.1, doc 03 §5.4): read the parts, look up the UUID, validate at
 * `REPEATABLE READ`, put the photos into the store, then one database transaction. The answer is synchronous:
 * `201` written now, `200` written before (same bytes), `409` the same UUID with other bytes. Every step is safe to
 * repeat, so a retry after a crash anywhere completes the submission and never duplicates it (doc 02 §6.2).
 */
import type { IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { formatDisplayNo, inspectionDate, photoKey, toWibIso } from '@m100/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { TabletClaims } from '../auth/tablet-token';
import { isDbUnavailable, isRetryableTransactionError } from '../db/database';
import { ApiProblem } from '../errors/problem';
import { RETRY_MS, ReadinessService } from '../master-data/readiness.service';
import { PHOTO_STORE, type PhotoStore } from '../photos/photo-store';
import type { Device } from '../repositories/device.repository';
import {
  type NewSubmission,
  type StoredPhoto,
  type StoredSubmission,
  SUBMISSION_REPOSITORY,
  type SubmissionRepository,
  type WriteResult,
} from '../repositories/submission.repository';
import { readSubmissionParts, type SubmissionParts } from './multipart';
import { SubmissionValidator, type ValidSubmission } from './submission-validator';

/** Photos put into the store at the same time (doc 03 §5.4). */
export const PHOTO_CONCURRENCY = 5;

const RETRY_AFTER = RETRY_MS / 1000;

/** The `SubmissionResult` schema of `04-openapi.yaml`. */
export interface SubmissionResult {
  submissionUuid: string;
  status: 'written';
  displayNo: string;
  writtenAt: string;
  totals: StoredSubmission['totals'];
}

export interface SubmitOutcome {
  status: 200 | 201;
  body: SubmissionResult;
}

/** The fields of the submission log line (doc 03 §5.8, NFR-10). */
interface SubmitLog {
  submissionUuid?: string;
  displayNo?: string;
  username?: string;
  po?: string;
  photoCount?: number;
  durationMs?: number;
  /** `written`, `already_written`, or the problem code of a refusal. */
  result?: string;
  status?: number;
}

const uuid = z.uuidv4();

@Injectable()
export class SubmissionService {
  private readonly logger = new Logger('Submissions');
  private readonly locks = new KeyedLock();

  constructor(
    @Inject(SubmissionValidator) private readonly validator: SubmissionValidator,
    @Inject(SUBMISSION_REPOSITORY) private readonly submissions: SubmissionRepository,
    @Inject(PHOTO_STORE) private readonly photos: PhotoStore,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}

  async submit(req: IncomingMessage, device: Device, claims: TabletClaims): Promise<SubmitOutcome> {
    const started = performance.now();
    const log: SubmitLog = {};
    let parts: SubmissionParts | undefined;
    try {
      parts = await readSubmissionParts(req);
      Object.assign(log, describe(parts.body));
      this.checkReady();
      const id = uuid.safeParse(log.submissionUuid).success ? log.submissionUuid! : null;
      const read = parts;
      // One request per UUID at a time in this process: a second request with other bytes is refused before it
      // could overwrite the first one's photo files. `ON CONFLICT` covers requests in other processes.
      const outcome = await (id
        ? this.locks.run(id, () => this.process(read, id, device, claims))
        : this.process(read, null, device, claims));
      Object.assign(log, {
        displayNo: outcome.body.displayNo,
        result: outcome.status === 201 ? 'written' : 'already_written',
        status: outcome.status,
      });
      return outcome;
    } catch (error) {
      const problem = error instanceof ApiProblem ? error : undefined;
      Object.assign(log, {
        result: problem?.code ?? 'INTERNAL',
        status: problem?.getStatus() ?? 500,
      });
      throw error;
    } finally {
      log.durationMs = Math.round(performance.now() - started);
      this.writeLog(log, parts);
    }
  }

  /** Steps 1–5 of doc 02 §6.1 for one request; `id` is `null` when the JSON has no usable UUID. */
  private async process(
    parts: SubmissionParts,
    id: string | null,
    device: Device,
    claims: TabletClaims,
  ): Promise<SubmitOutcome> {
    // Step 1: written before?
    if (id) {
      const existing = await this.database(() => this.submissions.findById(id));
      if (existing) return repeat(existing, parts.payloadSha256);
    }
    // Step 2: every check of doc 04 §4.2, at REPEATABLE READ.
    const valid = await this.database(() => this.validator.validate(parts, claims));
    // Step 3: photos first, so no row ever points to a missing file.
    const photos = await this.putPhotos(valid);
    // Step 4: one transaction.
    const result = await this.database(() => this.write(toNewSubmission(valid, device, photos)));
    if (!result.written) return repeat(result.submission, parts.payloadSha256);
    // Step 5.
    return { status: 201, body: toResult(result.submission) };
  }

  /**
   * Submit PO only while every readiness check passes (doc 02 §10). A failed `DB` or `PHOTO_STORE` check answers
   * with its own code (doc 03 §5.7); any other failed check is `SUBMIT_DISABLED` with the reason.
   */
  private checkReady(): void {
    const status = this.readiness.current();
    if (status.submitEnabled) return;
    const failing = status.checks.filter((c) => !c.ok);
    if (failing.some((c) => c.id === 'DB')) {
      throw new ApiProblem('DB_UNAVAILABLE', { retryAfter: RETRY_AFTER });
    }
    if (failing.some((c) => c.id === 'PHOTO_STORE')) {
      throw new ApiProblem('PHOTO_STORE_UNAVAILABLE', { retryAfter: RETRY_AFTER });
    }
    throw new ApiProblem('SUBMIT_DISABLED', {
      retryAfter: RETRY_AFTER,
      detail: `Pengiriman sedang dinonaktifkan: ${failing.map((c) => c.message ?? c.id).join('; ')}`,
    });
  }

  /**
   * Runs a database step. An unreachable database flips the `DB` check and answers `503 DB_UNAVAILABLE`; any other
   * error (a constraint, the totals re-check) passes on and becomes `500 INTERNAL` (doc 03 §5.7).
   */
  private async database<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ApiProblem || !isDbUnavailable(error)) throw error;
      this.readiness.reportFailure('DB', error);
      throw new ApiProblem('DB_UNAVAILABLE', { retryAfter: RETRY_AFTER });
    }
  }

  /** The write transaction, run once more after a serialization failure or deadlock (doc 03 §5.7). */
  private async write(submission: NewSubmission): Promise<WriteResult> {
    try {
      return await this.submissions.write(submission);
    } catch (error) {
      if (!isRetryableTransactionError(error)) throw error;
      return this.submissions.write(submission);
    }
  }

  /**
   * Puts every photo under its deterministic key (doc 02 §7), at most `PHOTO_CONCURRENCY` at a time. Putting a key
   * again with the same bytes is harmless, so a retry simply repeats this. A store error flips the `PHOTO_STORE`
   * check and answers `503 PHOTO_STORE_UNAVAILABLE`; puts already running are waited for first.
   */
  private async putPhotos(valid: ValidSubmission): Promise<StoredPhoto[]> {
    const { submissionUuid, sealedAt } = valid.request;
    const photos = valid.photos.map((p) => ({
      ...p,
      key: photoKey(submissionUuid, p.defectId, sealedAt),
    }));
    try {
      await eachLimited(photos, PHOTO_CONCURRENCY, (p) =>
        this.photos.put(p.key, p.bytes, p.sha256),
      );
    } catch (error) {
      this.readiness.reportFailure('PHOTO_STORE', error);
      throw new ApiProblem('PHOTO_STORE_UNAVAILABLE', { retryAfter: RETRY_AFTER });
    }
    return photos.map((p) => ({
      defectId: p.defectId,
      objectKey: p.key,
      sha256: Buffer.from(p.sha256, 'hex'),
      sizeBytes: p.size,
    }));
  }

  /**
   * The submission log line (doc 03 §5.8). A server error also logs the JSON part, so the submission can be
   * examined (doc 03 §5.7); it holds no key, token or photo bytes.
   */
  private writeLog(log: SubmitLog, parts: SubmissionParts | undefined): void {
    if (log.status === 500) {
      this.logger.error({ ...log, submission: parts?.json.toString('utf8') }, 'Submit PO');
    } else if ((log.status ?? 500) >= 400) {
      this.logger.warn(log, 'Submit PO');
    } else {
      this.logger.log(log, 'Submit PO');
    }
  }
}

/** The stored result for a repeated UUID: `200` with the same bytes, `409` with others (doc 04 §4.3). */
function repeat(stored: StoredSubmission, payloadSha256: string): SubmitOutcome {
  if (!stored.payloadSha256.equals(Buffer.from(payloadSha256, 'hex'))) {
    throw new ApiProblem('SUBMISSION_UUID_REUSED');
  }
  return { status: 200, body: toResult(stored) };
}

function toResult(stored: StoredSubmission): SubmissionResult {
  return {
    submissionUuid: stored.id,
    status: 'written',
    displayNo: formatDisplayNo(stored.displayNo),
    writtenAt: toWibIso(stored.receivedAt),
    totals: stored.totals,
  };
}

function toNewSubmission(
  valid: ValidSubmission,
  device: Device,
  photos: StoredPhoto[],
): NewSubmission {
  const r = valid.request;
  return {
    id: r.submissionUuid,
    payloadSha256: Buffer.from(valid.payloadSha256, 'hex'),
    sealedAt: r.sealedAt,
    inspectionDate: inspectionDate(r.sealedAt),
    appVersion: r.appVersion,
    deviceId: device.id,
    username: r.user.username,
    level: r.user.level,
    factory: r.factory,
    cell: r.cell,
    po: r.po,
    partial: r.partial,
    counts: r.counts,
    totals: valid.totals,
    findings: r.findings,
    photos,
  };
}

/** What the log line can say about a request before it is validated. */
function describe(body: unknown): SubmitLog {
  if (body === null || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    submissionUuid: text(b.submissionUuid),
    username: text((b.user as Record<string, unknown> | undefined)?.username),
    po: text(b.po),
    photoCount: Array.isArray(b.photos) ? b.photos.length : 0,
  };
}

/** Runs `fn` on every item, at most `limit` at a time; after a failure starts no more, waits, then throws it. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}

/** Runs tasks with the same key one after the other, tasks with different keys freely. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(fn);
    const tail = current.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await current;
    } finally {
      // The last task of a key removes it, so the map does not grow with every submission.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
