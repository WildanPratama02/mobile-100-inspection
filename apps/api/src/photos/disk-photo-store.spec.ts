import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
// The module object itself (not an import namespace), so jest.spyOn can replace rename for the store too.
const fsPromises = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describePhotoStore,
  ESCAPING_KEYS,
  jpeg,
  listAll,
  photoKey,
  readAll,
  sha256,
} from '../testing/photo-store-contract';
import { DiskPhotoStore } from './disk-photo-store';
import { createPhotoStore } from './photo-store.module';
import { S3PhotoStore } from './s3-photo-store';

let base: string;
let photoDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'm100-photos-'));
  photoDir = join(base, 'photos');
  await mkdir(photoDir);
});
afterEach(async () => {
  jest.restoreAllMocks();
  // Windows: a read stream's handle may still be closing.
  await rm(base, { recursive: true, force: true, maxRetries: 5 });
});

/** Every file below `dir`, as paths relative to it with `/`. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) =>
      join(e.parentPath, e.name)
        .slice(dir.length + 1)
        .replaceAll('\\', '/'),
    )
    .sort();
}

describePhotoStore('DiskPhotoStore', () => Promise.resolve(new DiskPhotoStore(photoDir)));

describe('DiskPhotoStore on the folder (T2.3)', () => {
  it('stores a key as the relative path under PHOTO_DIR', async () => {
    const store = new DiskPhotoStore(photoDir);
    const key = 'submissions/2026/10/0f6b6c1e-6a52-4c9f-9a3e-5d7a2b0c41f2/D035.jpg';
    const bytes = jpeg(key);
    await store.put(key, bytes, sha256(bytes));
    const onDisk = await readFile(
      join(
        photoDir,
        'submissions',
        '2026',
        '10',
        '0f6b6c1e-6a52-4c9f-9a3e-5d7a2b0c41f2',
        'D035.jpg',
      ),
    );
    expect(onDisk.equals(bytes)).toBe(true);
    expect(await filesUnder(photoDir)).toEqual([key]);
  });

  it('writes nothing outside PHOTO_DIR for an escaping key', async () => {
    const store = new DiskPhotoStore(photoDir);
    const bytes = jpeg('escape');
    for (const key of ESCAPING_KEYS) {
      await store.put(key, bytes, sha256(bytes)).catch(() => undefined);
    }
    expect(await filesUnder(base)).toEqual([]);
  });

  it('is atomic: a failed rename keeps the old photo whole and leaves no temp file', async () => {
    const store = new DiskPhotoStore(photoDir);
    const key = photoKey();
    const old = jpeg('old');
    await store.put(key, old, sha256(old));

    const failure = Object.assign(new Error('disk full'), { code: 'EIO' });
    const rename = jest.spyOn(fsPromises, 'rename').mockRejectedValue(failure);
    const next = jpeg('new');
    await expect(store.put(key, next, sha256(next))).rejects.toBe(failure);
    expect(rename).toHaveBeenCalledTimes(1);

    expect((await readAll(await store.get(key))).equals(old)).toBe(true);
    expect(await filesUnder(photoDir)).toEqual([key]);
  });

  it('writes the bytes to a temp file in the target folder and renames it over the target', async () => {
    const store = new DiskPhotoStore(photoDir);
    const key = photoKey();
    const bytes = jpeg(key);
    const rename = jest.spyOn(fsPromises, 'rename');
    await store.put(key, bytes, sha256(bytes));

    expect(rename).toHaveBeenCalledTimes(1);
    const [from, to] = rename.mock.calls[0]! as [string, string];
    expect(to).toBe(join(photoDir, ...key.split('/')));
    expect(join(from, '..')).toBe(join(to, '..'));
    expect(from).toMatch(/[\\/]\.D035\.jpg\.[0-9a-f]{12}\.tmp$/);
  });

  it('retries a rename that Windows refuses for a moment', async () => {
    const store = new DiskPhotoStore(photoDir);
    const key = photoKey();
    const bytes = jpeg(key);
    const real = fsPromises.rename;
    const busy = Object.assign(new Error('busy'), { code: 'EPERM' });
    const rename = jest
      .spyOn(fsPromises, 'rename')
      .mockRejectedValueOnce(busy)
      .mockImplementation((from, to) => real(from, to));
    await store.put(key, bytes, sha256(bytes));
    expect(rename).toHaveBeenCalledTimes(2);
    expect((await readAll(await store.get(key))).equals(bytes)).toBe(true);
    expect(await filesUnder(photoDir)).toEqual([key]);
  });

  it('does not rewrite a photo that already holds the same bytes, only renews its time', async () => {
    const store = new DiskPhotoStore(photoDir);
    const key = photoKey();
    const bytes = jpeg(key);
    await store.put(key, bytes, sha256(bytes));
    const file = join(photoDir, ...key.split('/'));
    const longAgo = new Date('2026-01-01T00:00:00Z');
    await utimes(file, longAgo, longAgo);

    const rename = jest.spyOn(fsPromises, 'rename');
    await store.put(key, bytes, sha256(bytes));
    expect(rename).not.toHaveBeenCalled();
    expect((await stat(file)).mtime.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('lists only keys: temp files and other names in the folder are skipped', async () => {
    const store = new DiskPhotoStore(photoDir);
    const key = photoKey();
    const bytes = jpeg(key);
    await store.put(key, bytes, sha256(bytes));
    const folder = join(photoDir, ...key.split('/').slice(0, -1));
    await writeFile(join(folder, '.D035.jpg.0123456789ab.tmp'), 'partial');
    await writeFile(join(photoDir, 'not a key.txt'), 'x');
    await mkdir(join(photoDir, 'empty', 'folder'), { recursive: true });
    expect((await listAll(store)).map((p) => p.key)).toEqual([key]);
  });

  it('refuses to put when PHOTO_DIR does not exist, and creates nothing', async () => {
    const missing = join(base, 'not-mounted');
    const store = new DiskPhotoStore(missing);
    const bytes = jpeg('x');
    await expect(store.put(photoKey(), bytes, sha256(bytes))).rejects.toThrow('is not a folder');
    await expect(store.probe()).rejects.toThrow('is not a folder');
    expect(await readdir(base)).toEqual(['photos']);
  });

  it('leaves nothing behind after the probe', async () => {
    await new DiskPhotoStore(photoDir).probe();
    expect(await filesUnder(photoDir)).toEqual([]);
  });

  it('touches nothing on disk when constructed', async () => {
    new DiskPhotoStore(join(base, 'later'));
    expect(await readdir(base)).toEqual(['photos']);
  });
});

describe('createPhotoStore (PHOTO_STORE)', () => {
  it('gives a DiskPhotoStore for disk', () => {
    expect(createPhotoStore({ kind: 'disk', dir: photoDir })).toBeInstanceOf(DiskPhotoStore);
  });

  it('gives an S3PhotoStore for s3', () => {
    const store = createPhotoStore({
      kind: 's3',
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'm100-photos',
      accessKey: 'a',
      secretKey: 'b',
    });
    expect(store).toBeInstanceOf(S3PhotoStore);
    (store as S3PhotoStore).destroy();
  });
});
