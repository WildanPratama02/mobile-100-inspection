/**
 * Where photos live (doc 03 §5.2, doc 02 §7). Keys are `submissions/<yyyy>/<MM>/<uuid>/<defectId>.jpg`; the store
 * keeps the JPEG bytes as received and never re-encodes them. Release 1 uses `DiskPhotoStore`; `S3PhotoStore` is built
 * and tested but not deployed.
 */
import type { Readable } from 'node:stream';

export const PHOTO_STORE = Symbol('PhotoStore');

export interface ListedPhoto {
  key: string;
  /** When the object was last put; a put of the same bytes renews it, so a retry's photos count as new. */
  lastModified: Date;
}

export interface PhotoStore {
  /**
   * Stores `jpeg` under `key`. Putting the same key again is allowed (a retry brings the same bytes) and renews
   * `lastModified`, so the orphan sweep never takes the photos of a retry that is still under way.
   */
  put(key: string, jpeg: Buffer, sha256: string): Promise<void>;
  /** Fails with `PhotoNotFound` when nothing is stored under `key`. */
  get(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  /** Orphan sweep only (doc 02 §6.2). Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Readiness check `PHOTO_STORE` (doc 02 §10): a probe object can be put, read and deleted. */
  probe(): Promise<void>;
  /** Every stored object, in no particular order. Orphan sweep only (doc 02 §6.2). */
  list(): AsyncIterable<ListedPhoto>;
}

/**
 * One key segment: letters, digits, `.`, `_`, `-`, neither starting nor ending with a dot. That rules out `.` and
 * `..`, drive letters, `\`, `:` (NTFS streams), names Windows would silently trim, and the dot-prefixed temp files.
 */
const SEGMENT = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
/** Windows device names, which address a device instead of a file whatever the extension. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

/**
 * The segments of `key`, refusing anything that is not a plain relative path of safe segments. Every store applies
 * the same rule, so a key that works on one works on the other.
 */
export function photoKeySegments(key: string): string[] {
  const segments = key.split('/');
  if (!segments.every((s) => SEGMENT.test(s) && !DEVICE_NAME.test(s))) {
    throw new InvalidPhotoKey(key);
  }
  return segments;
}

/** Whether `key` passes `photoKeySegments`. */
export function isPhotoKey(key: string): boolean {
  try {
    photoKeySegments(key);
    return true;
  } catch {
    return false;
  }
}

/** A key that is not a plain relative path of safe segments, or that would leave the store. */
export class InvalidPhotoKey extends Error {
  constructor(readonly key: string) {
    super(`Invalid photo key: ${JSON.stringify(key)}`);
    this.name = 'InvalidPhotoKey';
  }
}

export class PhotoNotFound extends Error {
  constructor(readonly key: string) {
    super(`No photo stored under ${key}`);
    this.name = 'PhotoNotFound';
  }
}

/** The bytes handed to `put` do not have the SHA-256 the caller stated. */
export class PhotoChecksumMismatch extends Error {
  constructor(readonly key: string) {
    super(`SHA-256 of the photo for ${key} does not match`);
    this.name = 'PhotoChecksumMismatch';
  }
}
