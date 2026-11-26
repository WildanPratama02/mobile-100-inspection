/**
 * `pnpm release [--skip-build]` (T4.1, doc 03 §7.6): builds everything and assembles one release for the Windows
 * server in `release/<version>/`, zipped as `release/m100-<version>.zip`, which install.ps1 and upgrade.ps1 unpack
 * into `C:\m100\releases\<version>`:
 *
 *   web/  admin/  api/ (dist + production node_modules)  db/migrations/  reference/mapping/  deploy/  VERSION
 *
 * `api/dist` finds `db/migrations` and `reference/mapping` in its nearest ancestor, so they sit next to `api/`.
 * Run it on Windows x64: `node_modules` holds the native `@node-rs/argon2` binary of the machine that builds it.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What the server needs from `deploy/`. */
export const DEPLOY_FILES = [
  'Caddyfile',
  'security-headers.json',
  'cache-control.json',
  'windows/common.ps1',
  'windows/precheck.ps1',
  'windows/install.ps1',
  'windows/upgrade.ps1',
  'windows/restore.ps1',
  'windows/m100.ps1',
  'windows/m100-api.xml',
  'windows/m100-caddy.xml',
];

/** What the Linux server (CentOS + Nginx + systemd) needs from `deploy/`. */
export const DEPLOY_FILES_LINUX = [
  'security-headers.json',
  'cache-control.json',
  'linux/m100.conf',
  'linux/m100-headers.conf',
  'linux/m100-api.service',
  'linux/m100-backup.service',
  'linux/m100-backup.timer',
  'linux/m100-sweep.service',
  'linux/m100-sweep.timer',
  'linux/env.example',
  'linux/install.sh',
  'linux/upgrade.sh',
  'linux/m100.sh',
];

/** Native argon2 packages of every platform but linux-x64-gnu, dropped from a Linux release. */
export function isForeignArgon2(name) {
  return name.startsWith('argon2-') && name !== 'argon2-linux-x64-gnu';
}

/** Kept of the API package after `pnpm deploy`, which also copies sources and any local `.env`. */
const API_ENTRIES = ['dist', 'node_modules', 'package.json'];

/** `yyyy.MM.dd-<short sha>` (date in WIB), with `-dirty` when the working tree has uncommitted changes. */
export function releaseVersion(date, sha, dirty) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(date)
    .replaceAll('-', '.');
  return `${day}-${sha}${dirty ? '-dirty' : ''}`;
}

/** Paths under `dir` that must never ship: `.env` files and `secrets` folders (relative, `/`-separated). */
export function forbiddenPaths(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const name = entry.name;
    const isEnv =
      entry.isFile() && (name === '.env' || (name.startsWith('.env.') && name !== '.env.example'));
    const isSecrets = entry.isDirectory() && name === 'secrets';
    if (isEnv || isSecrets) {
      found.push(relative(dir, join(entry.parentPath, name)).split('\\').join('/'));
    }
  }
  return found;
}

function run(command, args, options = {}) {
  process.stdout.write(`> ${command} ${args.join(' ')}\n`);
  // pnpm is a .cmd shim on Windows, which needs a shell.
  execFileSync(command, args, {
    cwd: repo,
    stdio: 'inherit',
    shell: command === 'pnpm',
    ...options,
  });
}

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function main() {
  // `pnpm release` builds for the Linux server (default); `pnpm release -- --target windows` for the old Windows one.
  const targetArg = process.argv.indexOf('--target');
  const target = targetArg > -1 ? process.argv[targetArg + 1] : 'linux';
  if (target !== 'linux' && target !== 'windows') throw new Error('--target is linux or windows');
  if (target === 'windows' && process.platform !== 'win32') {
    throw new Error('A Windows release is built on Windows x64: the API ships native modules');
  }
  const linux = target === 'linux';
  const skipBuild = process.argv.includes('--skip-build');
  const version = releaseVersion(
    new Date(),
    git('rev-parse', '--short', 'HEAD'),
    git('status', '--porcelain') !== '',
  );
  const out = join(repo, 'release', version);
  const zip = join(repo, 'release', `m100-${version}.${linux ? 'tar.gz' : 'zip'}`);
  rmSync(out, { recursive: true, force: true });
  rmSync(zip, { force: true });
  mkdirSync(out, { recursive: true });

  if (!skipBuild) run('pnpm', ['build']);

  // Production dependencies only, as real folders (no links) so the zip unpacks anywhere.
  const apiOut = join(out, 'api');
  run('pnpm', [
    '--filter',
    'api',
    '--config.node-linker=hoisted',
    'deploy',
    '--prod',
    '--legacy',
    relative(repo, apiOut),
  ]);
  for (const entry of readdirSync(apiOut)) {
    if (!API_ENTRIES.includes(entry)) rmSync(join(apiOut, entry), { recursive: true, force: true });
  }

  if (linux) {
    // pnpm-workspace.yaml `supportedArchitectures` installs the linux-x64-gnu binary next to this machine's own;
    // keep only the one the server loads.
    const scope = join(apiOut, 'node_modules', '@node-rs');
    if (!existsSync(join(scope, 'argon2-linux-x64-gnu'))) {
      throw new Error(
        '@node-rs/argon2-linux-x64-gnu missing: run `pnpm install` (supportedArchitectures)',
      );
    }
    for (const name of readdirSync(scope)) {
      if (isForeignArgon2(name)) rmSync(join(scope, name), { recursive: true, force: true });
    }
  }

  const copy = (from, to) => {
    const source = join(repo, from);
    if (!existsSync(source)) throw new Error(`${from} not found: did the build run?`);
    cpSync(source, join(out, to), { recursive: true });
  };
  copy('apps/web/dist', 'web');
  copy('apps/admin/dist', 'admin');
  copy('db/migrations', 'db/migrations');
  copy('reference/mapping', 'reference/mapping');
  copy('docs/phase5-recovery-runbook.md', 'docs/phase5-recovery-runbook.md');
  if (linux) copy('docs/deploy-centos-nginx.md', 'docs/deploy-centos-nginx.md');
  for (const file of linux ? DEPLOY_FILES_LINUX : DEPLOY_FILES)
    copy(join('deploy', file), join('deploy', file));
  writeFileSync(join(out, 'VERSION'), `${version}\n`);

  const forbidden = forbiddenPaths(out);
  if (forbidden.length > 0) {
    throw new Error(`The release contains files that must never ship: ${forbidden.join(', ')}`);
  }

  // Windows' own bsdtar writes both formats (-a by the extension): zip for Expand-Archive, tar.gz for the Linux server.
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  run(tar, ['-a', '-c', '-f', zip, '-C', out, '.']);
  process.stdout.write(
    `\nRelease ${version}\n  ${relative(repo, out)}\n  ${relative(repo, zip)}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release failed: ${error.message}\n`);
    process.exit(1);
  }
}
