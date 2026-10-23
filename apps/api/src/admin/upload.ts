/**
 * Reads the multipart body of an admin import (doc 04 §8: `POST /admin/pos/import`, `/admin/area-map/import`) into
 * memory: one part `file`, at most 20 MB (doc 03 §6), else `413 PAYLOAD_TOO_LARGE`. A body that is not multipart, or
 * has no `file` part, is `422 VALIDATION_FAILED`. Nothing is written to disk.
 */
import type { IncomingMessage } from 'node:http';
import { basename } from 'node:path';
import busboy from 'busboy';
import { ApiProblem } from '../errors/problem';
import { checksFailed } from '../errors/validation';

export const UPLOAD_LIMIT = 20 * 1024 * 1024;
export const UPLOAD_PART = 'file';

export interface Upload {
  /** The file name the browser sent, without any folder; `upload` when it sent none. */
  name: string;
  bytes: Buffer;
}

const tooLarge = () => new ApiProblem('PAYLOAD_TOO_LARGE', { detail: 'Berkas lebih dari 20 MB.' });
const unreadable = (message: string) =>
  checksFailed([{ path: UPLOAD_PART, code: 'INVALID', message }]);

export function readUpload(req: IncomingMessage, limit = UPLOAD_LIMIT): Promise<Upload> {
  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy | undefined;
    let settled = false;
    // The rest of a refused body is read and dropped before answering, so the browser sees the answer.
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

    if (!/^multipart\/form-data\b/i.test(req.headers['content-type'] ?? '')) {
      fail(unreadable('Kiriman harus multipart/form-data.'));
      return;
    }
    // A little room for the multipart framing around a file of exactly the limit.
    if (Number(req.headers['content-length']) > limit + 64 * 1024) {
      fail(tooLarge());
      return;
    }
    try {
      parser = busboy({ headers: req.headers, limits: { files: 1, fileSize: limit, fields: 10 } });
    } catch {
      fail(unreadable('Multipart tidak terbaca.'));
      return;
    }

    let upload: Upload | undefined;
    parser.on('file', (name, stream, info) => {
      if (name !== UPLOAD_PART) {
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => fail(tooLarge()));
      stream.on('end', () => {
        // A Windows browser may send a full path; only the name is kept (it becomes `pos.source`).
        const name = basename((info.filename ?? '').replace(/\\/g, '/')).trim();
        upload = { name: name === '' ? 'upload' : name, bytes: Buffer.concat(chunks) };
      });
    });
    parser.on('error', () => fail(unreadable('Multipart tidak terbaca.')));
    parser.on('close', () => {
      if (settled) return;
      settled = true;
      if (!upload) reject(unreadable('Part file tidak ada.'));
      else resolve(upload);
    });
    req.pipe(parser);
  });
}
