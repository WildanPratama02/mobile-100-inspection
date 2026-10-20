/**
 * The behaviour every `PhotoStore` must have (doc 03 §5.2). `DiskPhotoStore` runs it now; `S3PhotoStore` (T3.4) runs
 * the same suite against a throw-away S3 container.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  InvalidPhotoKey,
  PhotoChecksumMismatch,
  PhotoNotFound,
  type PhotoStore,
} from '../photos/photo-store';

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** JPEG-looking bytes (signature `FF D8 FF`), different for every `seed`. */
export function jpeg(seed: string, size = 2048): Buffer {
  const body = Buffer.alloc(size);
  createHash('sha512').update(seed).digest().copy(body);
  body.write(seed, 64);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), body, Buffer.from([0xff, 0xd9])]);
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function photoKey(defectId = 'D035'): string {
  return `submissions/2026/10/${randomUUID()}/${defectId}.jpg`;
}

/** Keys that are not plain relative paths of safe segments, or that would leave the store. */
export const ESCAPING_KEYS = [
  '',
  '../x.jpg',
  '../../x.jpg',
  'submissions/../../x.jpg',
  'submissions/2026/../../../x.jpg',
  '/etc/x.jpg',
  'C:/x.jpg',
  'C:\\x.jpg',
  'submissions\\..\\..\\x.jpg',
  '\\\\server\\share\\x.jpg',
  'submissions/./x.jpg',
  'submissions//x.jpg',
  'submissions/x.jpg/',
  'x.jpg:stream',
  'submissions/x.jpg.',
  'submissions/CON.jpg',
  'submissions/.hidden.jpg',
  'submissions/%2e%2e/x.jpg',
];

export function describePhotoStore(name: string, make: () => Promise<PhotoStore>): void {
  describe(`${name} (PhotoStore contract, doc 03 §5.2)`, () => {
    let store: PhotoStore;
    beforeEach(async () => {
      store = await make();
    });

    it('returns what was put, byte for byte', async () => {
      const key = photoKey();
      const bytes = jpeg(key);
      await store.put(key, bytes, sha256(bytes));
      expect(await store.exists(key)).toBe(true);
      expect((await readAll(await store.get(key))).equals(bytes)).toBe(true);
    });

    it('accepts the checksum in upper case hex too', async () => {
      const key = photoKey();
      const bytes = jpeg(key);
      await store.put(key, bytes, sha256(bytes).toUpperCase());
      expect(await store.exists(key)).toBe(true);
    });

    it('does not know a key that was never put', async () => {
      const key = photoKey();
      expect(await store.exists(key)).toBe(false);
      await expect(store.get(key)).rejects.toBeInstanceOf(PhotoNotFound);
    });

    it('is idempotent: the same key and bytes again, also in parallel, leave one identical photo', async () => {
      const key = photoKey();
      const bytes = jpeg(key);
      await store.put(key, bytes, sha256(bytes));
      await store.put(key, bytes, sha256(bytes));
      await Promise.all(Array.from({ length: 8 }, () => store.put(key, bytes, sha256(bytes))));
      expect((await readAll(await store.get(key))).equals(bytes)).toBe(true);
    });

    it('replaces the photo when the same key is put with other bytes', async () => {
      const key = photoKey();
      const first = jpeg('first');
      const second = jpeg('second');
      await store.put(key, first, sha256(first));
      await store.put(key, second, sha256(second));
      expect((await readAll(await store.get(key))).equals(second)).toBe(true);
    });

    it('refuses bytes whose SHA-256 differs from the stated one, storing nothing', async () => {
      const key = photoKey();
      const bytes = jpeg(key);
      await expect(store.put(key, bytes, sha256(jpeg('other')))).rejects.toBeInstanceOf(
        PhotoChecksumMismatch,
      );
      expect(await store.exists(key)).toBe(false);
    });

    it('deletes a photo, and deleting a missing one is not an error', async () => {
      const key = photoKey();
      const bytes = jpeg(key);
      await store.put(key, bytes, sha256(bytes));
      await store.delete(key);
      expect(await store.exists(key)).toBe(false);
      await expect(store.delete(key)).resolves.toBeUndefined();
    });

    it('passes the readiness probe', async () => {
      await expect(store.probe()).resolves.toBeUndefined();
    });

    it.each(ESCAPING_KEYS)('refuses the key %j in every operation', async (key) => {
      const bytes = jpeg('escape');
      await expect(store.put(key, bytes, sha256(bytes))).rejects.toBeInstanceOf(InvalidPhotoKey);
      await expect(store.get(key)).rejects.toBeInstanceOf(InvalidPhotoKey);
      await expect(store.exists(key)).rejects.toBeInstanceOf(InvalidPhotoKey);
      await expect(store.delete(key)).rejects.toBeInstanceOf(InvalidPhotoKey);
    });
  });
}
