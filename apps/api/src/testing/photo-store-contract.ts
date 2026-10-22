/**
 * The behaviour every `PhotoStore` must have (doc 03 §5.2). `DiskPhotoStore` runs it on a temp folder, `S3PhotoStore`
 * on a throw-away bucket of a local S3 container (`testing/s3.ts`). `make` gives an empty store for every test.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { photoKey as submissionPhotoKey, type DefectId } from '@m100/shared';
import {
  InvalidPhotoKey,
  type ListedPhoto,
  PhotoChecksumMismatch,
  PhotoNotFound,
  type PhotoStore,
} from '../photos/photo-store';

/** `store.list()` sorted by key. */
export async function listAll(store: PhotoStore): Promise<ListedPhoto[]> {
  const listed: ListedPhoto[] = [];
  for await (const photo of store.list()) listed.push(photo);
  return listed.sort((a, b) => a.key.localeCompare(b.key));
}

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

/** A key as Submit PO makes it (doc 02 §7), for a new submission. */
export function photoKey(defectId: DefectId = 'D035'): string {
  return submissionPhotoKey(randomUUID(), defectId, '2026-10-16T14:32:05+07:00');
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

    it('passes the readiness probe and leaves nothing behind', async () => {
      await expect(store.probe()).resolves.toBeUndefined();
      expect(await listAll(store)).toEqual([]);
    });

    it('lists nothing when empty', async () => {
      expect(await listAll(store)).toEqual([]);
    });

    it('lists every stored photo with the time it was put, and not a deleted one', async () => {
      const kept = [photoKey('D001'), photoKey('D035')];
      const deleted = photoKey('D002');
      const before = Date.now();
      for (const key of [...kept, deleted]) {
        const bytes = jpeg(key);
        await store.put(key, bytes, sha256(bytes));
      }
      await store.delete(deleted);
      const listed = await listAll(store);
      expect(listed.map((p) => p.key)).toEqual([...kept].sort());
      for (const { lastModified } of listed) {
        // S3 keeps whole seconds; a local server shares this clock.
        expect(lastModified.getTime()).toBeGreaterThanOrEqual(before - 1_000);
        expect(lastModified.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
      }
    });

    it('renews the time when the same bytes are put again (a retry), so the sweep keeps them', async () => {
      const key = photoKey();
      const bytes = jpeg(key);
      await store.put(key, bytes, sha256(bytes));
      const [first] = await listAll(store);
      // More than S3's one-second resolution.
      await delay(1_100);
      await store.put(key, bytes, sha256(bytes));
      const [again] = await listAll(store);
      expect(again!.lastModified.getTime()).toBeGreaterThan(first!.lastModified.getTime());
      expect((await readAll(await store.get(key))).equals(bytes)).toBe(true);
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
