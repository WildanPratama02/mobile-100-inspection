/**
 * Admin passwords (doc 03 §6, doc 04 §8): argon2id hashes in `admins.password_hash` (`@node-rs/argon2` defaults:
 * argon2id, 19 MiB, 2 passes, 1 lane), at least 10 characters. A password is never logged or stored as typed.
 */
import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** Doc 04 §8: "password ≥ 10 characters". */
export const MIN_PASSWORD_LENGTH = 10;
/** Longest password accepted, so a huge body cannot keep the hash busy. */
export const MAX_PASSWORD_LENGTH = 256;

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** `false` for a wrong password and for a stored value that is not an argon2 hash. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Spends the time of one real check on a hash nobody knows, for a username that does not exist or is inactive, so
 * the answer time does not tell which usernames exist. Always `false`.
 */
export async function verifyDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  await verifyPassword(await dummyHash, password);
  return false;
}

/** Why `password` is not acceptable as a new admin password (Indonesian, for the admin app), or `null`. */
export function passwordProblem(password: string): string | null {
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) return `Password minimal ${MIN_PASSWORD_LENGTH} karakter.`;
  if (length > MAX_PASSWORD_LENGTH) return `Password maksimal ${MAX_PASSWORD_LENGTH} karakter.`;
  return null;
}
