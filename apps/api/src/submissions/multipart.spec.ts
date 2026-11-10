import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request, { type Response } from 'supertest';
import { ApiProblem, type ProblemBody } from '../errors/problem';
import {
  MULTIPART_LIMITS,
  type MultipartLimits,
  readSubmissionParts,
  sha256Hex,
} from './multipart';

const MB = 1024 * 1024;
let limits: MultipartLimits = MULTIPART_LIMITS;

/** Answers what `readSubmissionParts` read, or the problem it refused with. */
const server: Server = createServer((req, res) => {
  readSubmissionParts(req, limits).then(
    (parts) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          json: parts.json.toString('base64'),
          payloadSha256: parts.payloadSha256,
          body: parts.body,
          photos: Object.fromEntries([...parts.photos].map(([name, b]) => [name, sha256Hex(b)])),
        }),
      );
    },
    (error: unknown) => {
      const problem = error instanceof ApiProblem ? error : new ApiProblem('INTERNAL');
      res.writeHead(problem.getStatus(), { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify(problem.body));
    },
  );
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => {
  limits = MULTIPART_LIMITS;
});

const post = () => request(server).post('/');

interface Read {
  json: string;
  payloadSha256: string;
  body: unknown;
  photos: Record<string, string>;
}
const read = (res: Response) => res.body as Read;
const problem = (res: Response) => res.body as ProblemBody;
const jpeg = (size: number) => {
  const bytes = Buffer.alloc(size, 7);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};
// A non-ASCII character, so a decode/encode round trip would show in the hash.
const JSON_PART = JSON.stringify({ submissionUuid: 'x', model: 'DURAMO SL2 M', note: 'é' });

/**
 * Sends one photo part per id and a JSON part padded so that the whole body is exactly `size` bytes, with its
 * Content-Length, and answers the status and body text.
 */
function sendRaw(
  ids: readonly string[],
  photo: Buffer,
  size: number,
): Promise<{ status: number; body: string }> {
  const boundary = 'm100boundary';
  const head = (name: string, filename?: string) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"` +
        (filename ? `; filename="${filename}"\r\nContent-Type: image/jpeg` : '') +
        '\r\n\r\n',
    );
  const photos = ids.flatMap((id) => [
    head(`photo_${id}`, `${id}.jpg`),
    photo,
    Buffer.from('\r\n'),
  ]);
  const jsonHead = head('submission');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fixed = [...photos, jsonHead, tail].reduce((n, b) => n + b.length, 0);
  const pad = 'x'.repeat(size - fixed - JSON.stringify({ pad: '' }).length);
  const body = Buffer.concat([...photos, jsonHead, Buffer.from(JSON.stringify({ pad })), tail]);
  expect(body.length).toBe(size);
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': body.length,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('readSubmissionParts (doc 04 §4.1, doc 03 §5.6)', () => {
  it('keeps the JSON part byte for byte when it comes as a file part (a Blob on the tablet)', async () => {
    const photo = jpeg(200 * 1024);
    const res = await post()
      .attach('submission', Buffer.from(JSON_PART), {
        filename: 'blob',
        contentType: 'application/json',
      })
      .attach('photo_D035', photo, { filename: 'D035.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(Buffer.from(read(res).json, 'base64').toString('utf8')).toBe(JSON_PART);
    expect(read(res).payloadSha256).toBe(sha256Hex(Buffer.from(JSON_PART)));
    expect(read(res).body).toEqual(JSON.parse(JSON_PART));
    expect(read(res).photos).toEqual({ photo_D035: sha256Hex(photo) });
  });

  it('keeps the JSON part byte for byte when it comes as a text field', async () => {
    const res = await post().field('submission', JSON_PART);
    expect(res.status).toBe(200);
    expect(read(res).payloadSha256).toBe(sha256Hex(Buffer.from(JSON_PART)));
    expect(read(res).photos).toEqual({});
  });

  it('accepts a photo of exactly 1 MB and refuses 1 MB + 1 byte with 413', async () => {
    const ok = await post()
      .field('submission', JSON_PART)
      .attach('photo_D035', jpeg(MB), { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(ok.status).toBe(200);
    const res = await post()
      .field('submission', JSON_PART)
      .attach('photo_D035', jpeg(MB + 1), { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      detail: 'Ukuran foto terlalu besar.',
    });
  });

  it('has the doc 04 §7 limits: body 100 MB, photo 1 MB, 100 parts (ADR-022)', () => {
    expect(MULTIPART_LIMITS).toEqual({ body: 100 * MB, photo: MB, parts: 100 });
  });

  it('accepts 98 photos of 1 MB in a body of exactly 100 MB and refuses 100 MB + 1 byte with 413', async () => {
    const ids = Array.from({ length: 98 }, (_, i) => `D${String(i + 1).padStart(3, '0')}`);
    const photo = jpeg(MB);
    const sent = (size: number) => sendRaw(ids, photo, size);
    const ok = await sent(100 * MB);
    expect(ok.status).toBe(200);
    expect(Object.keys((JSON.parse(ok.body) as Read).photos)).toHaveLength(98);
    const over = await sent(100 * MB + 1);
    expect(over.status).toBe(413);
    expect((JSON.parse(over.body) as ProblemBody).code).toBe('PAYLOAD_TOO_LARGE');
  }, 60_000);

  it('refuses a body over the limit by its Content-Length with 413', async () => {
    limits = { ...MULTIPART_LIMITS, body: 64 * 1024 };
    const res = await post()
      .field('submission', JSON_PART)
      .attach('submission_extra', Buffer.alloc(64 * 1024 + 1), { filename: 'x' });
    expect(res.status).toBe(413);
    expect(problem(res).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('stops a chunked body without Content-Length at the limit with 413', async () => {
    limits = { ...MULTIPART_LIMITS, body: 64 * 1024 };
    const boundary = 'm100boundary';
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="submission"\r\n\r\n${JSON_PART}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="photo_D035"; filename="a.jpg"\r\n` +
          'Content-Type: image/jpeg\r\n\r\n',
      );
      // 40 chunks of 4 KB: 160 KB, no part over the photo limit's default, the body over 64 KB.
      for (let i = 0; i < 40; i++) req.write(Buffer.alloc(4096, 1));
      req.end(`\r\n--${boundary}--\r\n`);
    });
    expect(status.status).toBe(413);
    expect((JSON.parse(status.body) as ProblemBody).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('refuses a request without the submission part', async () => {
    const res = await post().attach('photo_D035', jpeg(10), { filename: 'a.jpg' });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('VALIDATION_FAILED');
    expect(problem(res).errors).toEqual([
      { path: 'submission', code: 'REQUIRED', message: 'Part submission tidak ada.' },
    ]);
  });

  it('refuses a submission part that is not JSON', async () => {
    const res = await post().field('submission', '{not json');
    expect(res.status).toBe(422);
    expect(problem(res).errors).toEqual([
      { path: 'submission', code: 'INVALID', message: 'Part submission bukan JSON.' },
    ]);
  });

  it('refuses unknown and repeated parts, all in one answer', async () => {
    const res = await post()
      .field('submission', JSON_PART)
      .field('totals', '{}')
      .attach('photo_D35', jpeg(10), { filename: 'a.jpg' })
      .attach('photo_D035', jpeg(10), { filename: 'a.jpg' })
      .attach('photo_D035', jpeg(11), { filename: 'b.jpg' });
    expect(res.status).toBe(422);
    expect(problem(res).errors?.map((e) => [e.path, e.code])).toEqual([
      ['totals', 'UNKNOWN_PART'],
      ['photo_D35', 'UNKNOWN_PART'],
      ['photo_D035', 'DUPLICATE'],
    ]);
  });

  it('refuses a body that is not multipart/form-data', async () => {
    const res = await post().set('content-type', 'application/json').send(JSON_PART);
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('VALIDATION_FAILED');
  });
});
