/**
 * Reads the multipart body of `POST /submissions` (doc 04 §4.1) into memory: the `submission` JSON part as the
 * exact bytes the tablet sent (their SHA-256 is `payload_sha256`, doc 04 §4.3) and the photo parts
 * `photo_<DEFECT_ID>`. Sizes are checked here, before validation (doc 03 §5.6): the whole body ≤ 8 MB and each
 * photo ≤ 1 MB, else `413 PAYLOAD_TOO_LARGE`. Nothing is written to disk.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import busboy from 'busboy';
import { ApiProblem } from '../errors/problem';
import { checksFailed, type Failure } from '../errors/validation';

export interface MultipartLimits {
  /** The whole request body (doc 04 §7). */
  body: number;
  /** One photo part (doc 04 §7, AC-10.1). */
  photo: number;
  /** Parts of any kind: the JSON part plus at most one photo per defect. */
  parts: number;
}

export const MULTIPART_LIMITS: MultipartLimits = {
  body: 8 * 1024 * 1024,
  photo: 1024 * 1024,
  parts: 100,
};

/** A refused body is read and dropped up to this many times the body limit, then the connection is closed. */
const DRAIN_FACTOR = 4;

export const SUBMISSION_PART = 'submission';
const PHOTO_PART = /^photo_D\d{3}$/;

export interface SubmissionParts {
  /** The `submission` part byte for byte. */
  json: Buffer;
  /** SHA-256 of `json`, hex. */
  payloadSha256: string;
  /** `json` parsed, not yet checked. */
  body: unknown;
  /** Photo parts by name (`photo_D035`). */
  photos: Map<string, Buffer>;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The parts of a submission request. Rejects with `413 PAYLOAD_TOO_LARGE` over a size limit, and with
 * `422 VALIDATION_FAILED` for a body that is not multipart, a missing, repeated or unknown part, or a `submission`
 * part that is not JSON.
 */
export function readSubmissionParts(
  req: IncomingMessage,
  limits: MultipartLimits = MULTIPART_LIMITS,
): Promise<SubmissionParts> {
  return new Promise((resolve, reject) => {
    const unreadable = (message: string) => checksFailed([{ path: '', code: 'INVALID', message }]);
    let parser: busboy.Busboy | undefined;
    let settled = false;
    // Answering before the body is read makes the client see a reset connection, which the tablet would treat as
    // "no connection" and resend forever (doc 04 §5). So the rest is read and dropped first, up to a cap.
    const fail = (error: ApiProblem) => {
      if (settled) return;
      settled = true;
      if (parser) req.unpipe(parser);
      if (req.readableEnded) {
        reject(error);
        return;
      }
      req.once('end', () => reject(error));
      req.once('close', () => reject(error));
      req.resume();
    };

    // Counts the body as it arrives, also one without Content-Length (chunked).
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > limits.body) fail(new ApiProblem('PAYLOAD_TOO_LARGE'));
      if (received > limits.body * DRAIN_FACTOR) req.destroy();
    });

    if (!/^multipart\/form-data\b/i.test(req.headers['content-type'] ?? '')) {
      fail(unreadable('Kiriman harus multipart/form-data.'));
      return;
    }
    if (Number(req.headers['content-length']) > limits.body) {
      fail(new ApiProblem('PAYLOAD_TOO_LARGE'));
      return;
    }
    try {
      parser = busboy({
        headers: req.headers,
        // Photo sizes are checked per part below; these only stop what the body limit would stop anyway.
        limits: { fieldSize: limits.body, fileSize: limits.body, parts: limits.parts },
      });
    } catch {
      fail(unreadable('Multipart tidak terbaca.'));
      return;
    }

    let json: Buffer | undefined;
    const photos = new Map<string, Buffer>();
    const failures: Failure[] = [];
    const seen = new Set<string>();
    const accept = (name: string): boolean => {
      if (name !== SUBMISSION_PART && !PHOTO_PART.test(name)) {
        failures.push({ path: name, code: 'UNKNOWN_PART', message: 'Part tidak dikenal.' });
        return false;
      }
      if (seen.has(name)) {
        failures.push({
          path: name,
          code: 'DUPLICATE',
          message: 'Part dikirim lebih dari sekali.',
        });
        return false;
      }
      seen.add(name);
      return true;
    };

    parser.on('field', (name, value, info) => {
      if (info.valueTruncated) return fail(new ApiProblem('PAYLOAD_TOO_LARGE'));
      if (!accept(name)) return;
      if (name === SUBMISSION_PART) json = Buffer.from(value, 'utf8');
      else
        failures.push({ path: name, code: 'INVALID', message: 'Foto harus dikirim sebagai file.' });
    });

    // The tablet sends the JSON part as a Blob, so it may also arrive as a file part.
    parser.on('file', (name, stream) => {
      if (!accept(name)) {
        stream.resume();
        return;
      }
      const max = name === SUBMISSION_PART ? limits.body : limits.photo;
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) fail(new ApiProblem('PAYLOAD_TOO_LARGE'));
        else chunks.push(chunk);
      });
      stream.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if (name === SUBMISSION_PART) json = bytes;
        else photos.set(name, bytes);
      });
    });

    parser.on('partsLimit', () => fail(new ApiProblem('PAYLOAD_TOO_LARGE')));
    parser.on('error', () => fail(unreadable('Multipart tidak terbaca.')));
    parser.on('close', () => {
      if (settled) return;
      settled = true;
      let body: unknown;
      if (json === undefined) {
        if (!seen.has(SUBMISSION_PART)) {
          failures.push({
            path: SUBMISSION_PART,
            code: 'REQUIRED',
            message: 'Part submission tidak ada.',
          });
        }
      } else {
        try {
          body = JSON.parse(json.toString('utf8'));
        } catch {
          failures.push({
            path: SUBMISSION_PART,
            code: 'INVALID',
            message: 'Part submission bukan JSON.',
          });
        }
      }
      if (failures.length > 0 || json === undefined) {
        reject(checksFailed(failures));
        return;
      }
      resolve({ json, payloadSha256: sha256Hex(json), body, photos });
    });

    req.pipe(parser);
  });
}
