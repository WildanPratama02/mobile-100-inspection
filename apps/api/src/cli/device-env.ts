/**
 * Shared start of the `device:*` commands (doc 03 §7.4, §7.5): `.env` from the working directory (pnpm runs the
 * scripts in `apps/api`, the service in the install folder), the database as `m100_app`, and the folder the
 * person typed the command in, for relative paths.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPool, Database } from '../db/database';

export function loadCliEnv(): void {
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

export function openDatabase(command: string): Database {
  return new Database(createPool(requireEnv('DATABASE_URL'), `m100 ${command}`));
}

/** Where the person typed the command; pnpm sets INIT_CWD. */
export function fromInvocationDir(path: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

/** Times in the CLI output: WIB, to the minute. */
export function wib(date: Date | null): string {
  if (!date) return '-';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}
