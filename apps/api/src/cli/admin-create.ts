/**
 * `pnpm admin:create [--username <name>] [--reset]` (doc 03 §6, §7.4): the first admin, another one, or a new
 * password for an existing one (`--reset`, also clears a lock). The username defaults to `admin`; the password
 * (≥ 10 characters) is typed twice at a hidden prompt, or piped as the first line of standard input. There is no
 * built-in account: production's first admin is made with this command.
 *
 * `pnpm admin:create --dev-default` makes the development-only `admin` / `admin123`, and only when `NODE_ENV` is
 * `development` or `test` and the connected database is `m100_dev` or `m100_test_*`; otherwise it refuses and
 * writes nothing. Needs `DATABASE_URL`; writes an `audit_log` row (`script:admin:create`). Never prints a password.
 */
import type { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import {
  AdminAccountError,
  createAdmin,
  createDevDefaultAdmin,
  DEV_DEFAULT_ADMIN,
  pgAdminAccountRepositories,
  resetAdminPassword,
} from '../admin/admin-accounts';
import type { Database } from '../db/database';
import { loadCliEnv, openDatabase } from './device-env';
import { type PasswordInput, readNewPassword } from './password-prompt';

/** `--username` when not given; the account still needs its own strong password. */
const DEFAULT_USERNAME = 'admin';

const USAGE =
  'Usage: pnpm admin:create [--username <name>] [--reset]\n       pnpm admin:create --dev-default';

export interface AdminCreateIo {
  env: Readonly<Record<string, string | undefined>>;
  input: PasswordInput;
  output: Writable;
  /** Where prompts go. */
  prompt: Writable;
  openDatabase: () => Database;
}

export async function runAdminCreate(args: string[], io: AdminCreateIo): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      username: { type: 'string' },
      reset: { type: 'boolean', default: false },
      'dev-default': { type: 'boolean', default: false },
    },
  });
  if (values['dev-default'] && (values.username !== undefined || values.reset)) {
    throw new AdminAccountError(
      'USERNAME_INVALID',
      `--dev-default takes no other option\n${USAGE}`,
    );
  }

  if (values['dev-default']) {
    const db = io.openDatabase();
    try {
      const { created, database } = await createDevDefaultAdmin(
        db,
        pgAdminAccountRepositories(db),
        {
          nodeEnv: io.env.NODE_ENV,
        },
      );
      io.output.write(
        created
          ? `Development admin "${DEV_DEFAULT_ADMIN.username}" created in ${database} with the development ` +
              'default password. Never use it outside development.\n'
          : `Admin "${DEV_DEFAULT_ADMIN.username}" already exists in ${database}; nothing changed.\n`,
      );
    } finally {
      await db.end();
    }
    return;
  }

  const username = values.username ?? DEFAULT_USERNAME;
  const password = await readNewPassword(io.input, io.prompt);
  const db = io.openDatabase();
  try {
    const repos = pgAdminAccountRepositories(db);
    const actor = 'script:admin:create' as const;
    if (values.reset) {
      const admin = await resetAdminPassword(db, repos, { username, password, actor });
      io.output.write(
        `New password set for admin "${admin.username}".` +
          (admin.active ? '\n' : ' The account is inactive; an admin can reactivate it.\n'),
      );
    } else {
      const admin = await createAdmin(db, repos, { username, password, actor });
      io.output.write(`Admin "${admin.username}" created.\n`);
    }
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  loadCliEnv();
  runAdminCreate(process.argv.slice(2), {
    env: process.env,
    input: process.stdin,
    output: process.stdout,
    prompt: process.stderr,
    openDatabase: () => openDatabase('admin:create'),
  }).catch((error: unknown) => {
    process.stderr.write(`admin:create failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
