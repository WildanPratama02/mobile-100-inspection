/**
 * `PhotoStore` on a folder (`PHOTO_DIR`, doc 03 §5.2), the release 1 store. A key becomes a relative path under the
 * folder. A put writes a temp file next to the target and renames it over the target, so a reader sees either the
 * old file or the complete new one, never a partial one. The server is Windows: paths go through `node:path`, and a
 * rename that Windows refuses for a moment (a reader or a virus scanner holding the file) is retried.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  InvalidPhotoKey,
  PhotoChecksumMismatch,
  PhotoNotFound,
  type PhotoStore,
} from './photo-store';

/**
 * One key segment: letters, digits, `.`, `_`, `-`, neither starting nor ending with a dot. That rules out `.` and
 * `..`, drive letters, `\`, `:` (NTFS streams), names Windows would silently trim, and the dot-prefixed temp files.
 */
const SEGMENT = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
/** Windows device names, which address a device instead of a file whatever the extension. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

const RENAME_ATTEMPTS = 5;
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

const PROBE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

export class DiskPhotoStore implements PhotoStore {
  private readonly root: string;

  /** Touches nothing on disk; a missing folder shows up in `probe` and `put`. */
  constructor(dir: string) {
    this.root = resolve(dir);
  }

  async put(key: string, jpeg: Buffer, sha256: string): Promise<void> {
    const file = this.pathOf(key);
    if (createHash('sha256').update(jpeg).digest('hex') !== sha256.toLowerCase()) {
      throw new PhotoChecksumMismatch(key);
    }
    if (await holds(file, jpeg)) return;

    // The folder itself must exist: creating it would hide a share that is not mounted.
    if (!(await stat(this.root).catch(() => null))?.isDirectory()) {
      throw new Error(`PHOTO_DIR ${this.root} is not a folder`);
    }
    await mkdir(dirname(file), { recursive: true });
    const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const handle = await open(temp, 'wx');
      try {
        await handle.writeFile(jpeg);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameOver(temp, file, jpeg);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async get(key: string): Promise<Readable> {
    const file = this.pathOf(key);
    try {
      const handle = await open(file, 'r');
      return handle.createReadStream();
    } catch (error) {
      if (isCode(error, 'ENOENT')) throw new PhotoNotFound(key);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    const file = this.pathOf(key);
    return (await stat(file).catch(() => null))?.isFile() ?? false;
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async probe(): Promise<void> {
    const key = `_probe/${randomUUID()}.jpg`;
    await this.put(key, PROBE_BYTES, createHash('sha256').update(PROBE_BYTES).digest('hex'));
    try {
      const read = await readFile(this.pathOf(key));
      if (!read.equals(PROBE_BYTES)) throw new Error('Photo store probe read back other bytes');
    } finally {
      await this.delete(key);
    }
  }

  /** The file for `key`, refusing anything that is not a plain relative path inside the folder. */
  private pathOf(key: string): string {
    const segments = key.split('/');
    if (!segments.every((s) => SEGMENT.test(s) && !DEVICE_NAME.test(s))) {
      throw new InvalidPhotoKey(key);
    }
    const file = resolve(this.root, ...segments);
    const inside = relative(this.root, file);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
      throw new InvalidPhotoKey(key);
    return file;
  }
}

/** Whether `file` already holds exactly `bytes` (then a put has nothing to do). */
async function holds(file: string, bytes: Buffer): Promise<boolean> {
  try {
    return (await readFile(file)).equals(bytes);
  } catch {
    return false;
  }
}

async function renameOver(temp: string, file: string, bytes: Buffer): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      // A concurrent put of the same bytes may have won the race.
      if (await holds(file, bytes)) return;
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RENAME_ATTEMPTS || !RETRYABLE_RENAME.has(code)) throw error;
      await delay(25 * 2 ** attempt);
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}
