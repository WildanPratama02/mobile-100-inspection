/**
 * Runs `pg_dump` and `pg_restore` (doc 03 §7.6). The password goes in `PGPASSWORD`, never on the command line,
 * where every local user could read it in the process list.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export type PgTool = 'pg_dump' | 'pg_restore';

/** The tool in `pgBin` (`PG_BIN`, the PostgreSQL `bin` folder), else the name alone, found on `PATH`. */
export function pgToolPath(tool: PgTool, pgBin: string | undefined): string {
  if (!pgBin) return tool;
  return join(pgBin, process.platform === 'win32' ? `${tool}.exe` : tool);
}

/**
 * `url` without its password, and the password for `PGPASSWORD`. Query parameters are percent-encoded again:
 * `URL` writes a space as `+`, which libpq does not decode (`options=-c+role%3Dx` would name the setting `+role`).
 */
export function splitPassword(url: string): { url: string; password: string | undefined } {
  const parsed = new URL(url);
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  parsed.password = '';
  const query = [...parsed.searchParams]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  parsed.search = query ? `?${query}` : '';
  return { url: parsed.href, password };
}

/** Runs `tool` against the database of `url`; rejects with its error output when it exits with an error. */
export function runPgTool(
  tool: PgTool,
  url: string,
  args: readonly string[],
  pgBin: string | undefined,
): Promise<void> {
  const { url: withoutPassword, password } = splitPassword(url);
  const env = { ...process.env };
  if (password === undefined) delete env.PGPASSWORD;
  else env.PGPASSWORD = password;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pgToolPath(tool, pgBin), [...args, `--dbname=${withoutPassword}`], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) =>
      reject(
        new Error(
          `${tool} could not be started (${error.message}); set PG_BIN to the PostgreSQL bin folder`,
        ),
      ),
    );
    child.on('close', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${tool} exited with ${code}: ${stderr.trim()}`)),
    );
  });
}
