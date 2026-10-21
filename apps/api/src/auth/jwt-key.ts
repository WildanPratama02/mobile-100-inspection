import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from '../config/env';

/** Doc 03 §6: `jwt.key` holds at least 32 random bytes. */
export const MIN_JWT_KEY_BYTES = 32;

/**
 * The signing key from `JWT_KEY_FILE`, used as raw bytes. A relative path is taken from the working directory,
 * like `.env`. An unreadable or short file stops the start with a `ConfigError` naming `JWT_KEY_FILE`.
 */
export function readJwtKey(file: string): Buffer {
  const path = resolve(process.cwd(), file);
  let key: Buffer;
  try {
    key = readFileSync(path);
  } catch (error) {
    throw new ConfigError([
      {
        variable: 'JWT_KEY_FILE',
        message: `cannot be read (${path}: ${(error as NodeJS.ErrnoException).code ?? 'error'})`,
      },
    ]);
  }
  if (key.length < MIN_JWT_KEY_BYTES) {
    throw new ConfigError([
      {
        variable: 'JWT_KEY_FILE',
        message: `must hold at least ${MIN_JWT_KEY_BYTES} bytes (${path} has ${key.length})`,
      },
    ]);
  }
  return key;
}
