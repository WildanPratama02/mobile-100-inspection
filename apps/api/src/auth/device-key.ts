/**
 * Device keys (ADR-014, doc 03 §4.9, §6): 32 random bytes, written as base64url so the key fits the setup link's
 * fragment unchanged. Only `hashDeviceKey(key)` is ever stored; the key itself is shown once by `device:add`.
 */
import { createHash, randomBytes } from 'node:crypto';

/** 32 bytes in base64url without padding. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function generateDeviceKey(): string {
  return randomBytes(32).toString('base64url');
}

/** A value that can be a device key at all; anything else is refused without a database lookup. */
export function isDeviceKeyShape(value: string): boolean {
  return KEY_SHAPE.test(value);
}

/** The 32-byte SHA-256 kept in `devices.key_sha256`. */
export function hashDeviceKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/** `https://<host>/setup#k=<key>` (doc 03 §4.9). The fragment never reaches the server. */
export function setupLink(host: string, key: string): string {
  return `https://${host}/setup#k=${key}`;
}
