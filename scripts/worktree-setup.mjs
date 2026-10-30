// Setup for an agent worktree (docs/09-agent-workflow.md): installs packages and gives the worktree an
// `apps/api/.env` that names only the local test database server, so `*.db.spec.ts` and `pnpm e2e` run there.
// The real `.env` is never read or copied. Run from the worktree root: `pnpm worktree:setup`
// (Orca runs it as the repository's setup script).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function fail(message) {
  console.error(`worktree-setup: ${message}`);
  process.exit(1);
}

const worktree = path.resolve(git('rev-parse', '--show-toplevel'));
const main = path.dirname(
  path.resolve(git('rev-parse', '--path-format=absolute', '--git-common-dir')),
);
// Windows paths compare case-insensitively (`D:` and `d:` are the same folder).
const same = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
if (same(worktree, main)) {
  fail('this is the main checkout, not a worktree; its apps/api/.env is left alone');
}

execFileSync('pnpm', ['install', '--frozen-lockfile'], {
  cwd: worktree,
  stdio: 'inherit',
  shell: true,
});

const envFile = path.join(worktree, 'apps', 'api', '.env');
if (existsSync(envFile)) {
  console.log(`worktree-setup: ${envFile} exists, left unchanged`);
  process.exit(0);
}

const configFile = path.join(main, 'secrets', 'test-db.json');
if (!existsSync(configFile)) {
  console.warn(
    `worktree-setup: ${configFile} is missing, so database and e2e tests will not run here.\n` +
      'Create it once (docs/09-agent-workflow.md, "Test database"): ' +
      '{ "testAdminDatabaseUrl": "postgres://postgres:<password>@localhost:<port>/postgres", "pgBin": "<optional folder>" }',
  );
  process.exit(0);
}

let config;
try {
  config = JSON.parse(readFileSync(configFile, 'utf8'));
} catch {
  fail(`${configFile} is not valid JSON`);
}
let url;
try {
  url = new URL(config.testAdminDatabaseUrl);
} catch {
  fail(`testAdminDatabaseUrl in ${configFile} is not a URL`);
}
if (!LOCAL_HOSTS.has(url.hostname)) {
  fail(`testAdminDatabaseUrl must point at this machine (localhost), not ${url.hostname}`);
}

const lines = [
  '# Written by scripts/worktree-setup.mjs for this worktree only: the local test database server, no app secrets.',
  `TEST_ADMIN_DATABASE_URL=${url.href}`,
];
if (config.pgBin) lines.push(`PG_BIN=${config.pgBin}`);
writeFileSync(envFile, `${lines.join('\n')}\n`, { flag: 'wx' });
console.log(
  `worktree-setup: wrote ${envFile} (TEST_ADMIN_DATABASE_URL${config.pgBin ? ', PG_BIN' : ''})`,
);
