/**
 * Where photos live (doc 03 §5.2, doc 02 §7). Keys are `submissions/<yyyy>/<MM>/<uuid>/<defectId>.jpg`; the store
 * keeps the JPEG bytes as received and never re-encodes them. Release 1 uses `DiskPhotoStore`; `S3PhotoStore` is T3.4.
 */
import type { Readable } from 'node:stream';

export const PHOTO_STORE = Symbol('PhotoStore');

export interface PhotoStore {
  /** Stores `jpeg` under `key`. Putting the same key again is allowed (a retry brings the same bytes). */
  put(key: string, jpeg: Buffer, sha256: string): Promise<void>;
  /** Fails with `PhotoNotFound` when nothing is stored under `key`. */
  get(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  /** Orphan sweep only (doc 02 §6.2). Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Readiness check `PHOTO_STORE` (doc 02 §10): a probe object can be put, read and deleted. */
  probe(): Promise<void>;
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
