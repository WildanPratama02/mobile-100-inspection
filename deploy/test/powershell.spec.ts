import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const windowsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'windows');
const scripts = readdirSync(windowsDir).filter((f) => f.endsWith('.ps1'));
const common = join(windowsDir, 'common.ps1');

/** Runs `script` in Windows PowerShell 5.1 (the server's) and returns its stdout. */
function powershell(script: string): string {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0)
    throw new Error(`PowerShell failed (${result.status}):\n${result.stderr}${result.stdout}`);
  return result.stdout.trim();
}

/** Dot-sources common.ps1 and returns the JSON `expression` prints. */
function withCommon<T>(expression: string): T {
  const quoted = common.replaceAll("'", "''");
  return JSON.parse(
    powershell(`. '${quoted}'; ${expression} | ConvertTo-Json -Depth 5 -Compress`),
  ) as T;
}

describe('PowerShell scripts', () => {
  it('are ASCII only (Windows PowerShell 5.1 reads a file without BOM in the ANSI code page)', () => {
    for (const file of scripts) {
      const bytes = readFileSync(join(windowsDir, file));
      const offending = [...bytes].findIndex(
        (b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09),
      );
      expect({ file, offending }).toEqual({ file, offending: -1 });
    }
  });

  it.runIf(process.platform === 'win32')('parse without errors in Windows PowerShell 5.1', () => {
    const list = scripts.map((f) => `'${join(windowsDir, f).replaceAll("'", "''")}'`).join(',');
    const out = powershell(
      `$r = foreach ($f in @(${list})) { $t = $null; $e = $null; ` +
        `$null = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e); ` +
        `foreach ($x in $e) { '{0}:{1}: {2}' -f (Split-Path -Leaf $f), $x.Extent.StartLineNumber, $x.Message } }; ` +
        `@($r) -join [Environment]::NewLine`,
    );
    expect(out).toBe('');
  });
});

describe.runIf(process.platform === 'win32')('common.ps1', () => {
  // The long path: tmpdir() may be an 8.3 short name, which the junction target does not keep.
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'm100-deploy-')));
  const q = (path: string) => `'${path.replaceAll("'", "''")}'`;
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('reads and writes .env files as Node and Caddy expect them (UTF-8 without BOM, LF)', () => {
    const file = join(work, '.env');
    const values = withCommon<Record<string, string>>(
      `Write-TextFile ${q(file)} @('# comment', 'DATABASE_URL=postgres://a:b@127.0.0.1:5432/m100', '', 'TZ=Asia/Jakarta'); Read-DotEnv ${q(file)}`,
    );
    expect(values).toEqual({
      DATABASE_URL: 'postgres://a:b@127.0.0.1:5432/m100',
      TZ: 'Asia/Jakarta',
    });
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(bytes.includes(0x0d)).toBe(false);
  });

  it('makes URL-safe random secrets and escapes the superuser password', () => {
    const [a, b] = withCommon<string[]>('@((New-RandomSecret), (New-RandomSecret 40))');
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(b).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(withCommon<string>(`Get-AdminDatabaseUrl 'p@ss:w/rd' 5433`)).toBe(
      'postgres://postgres:p%40ss%3Aw%2Frd@127.0.0.1:5433/postgres',
    );
  });

  it('switches the junction without touching the release it pointed to', () => {
    const releases = join(work, 'releases');
    for (const v of ['a', 'b']) {
      mkdirSync(join(releases, v), { recursive: true });
      writeFileSync(join(releases, v, 'VERSION'), v);
    }
    const current = join(work, 'current');
    const targets = withCommon<string[]>(
      `Set-Junction ${q(current)} ${q(join(releases, 'a'))}; $one = Get-JunctionTarget ${q(current)}; ` +
        `Set-Junction ${q(current)} ${q(join(releases, 'b'))}; @($one, (Get-JunctionTarget ${q(current)}))`,
    );
    expect(targets).toEqual([join(releases, 'a'), join(releases, 'b')]);
    expect(readFileSync(join(releases, 'a', 'VERSION'), 'utf8')).toBe('a');
    expect(readFileSync(join(current, 'VERSION'), 'utf8')).toBe('b');
    expect(() =>
      withCommon(`Set-Junction ${q(join(releases, 'a'))} ${q(join(releases, 'b'))}`),
    ).toThrow(/not a junction/);
  });

  it('unpacks a release zip into releases\\<version> and finds the install folder', () => {
    const src = join(work, 'zip-src');
    mkdirSync(join(src, 'deploy', 'windows'), { recursive: true });
    writeFileSync(join(src, 'VERSION'), '2026.11.02-ab12cd3\n');
    writeFileSync(join(src, 'deploy', 'windows', 'm100.ps1'), '# m100');
    const zip = join(work, 'm100-2026.11.02-ab12cd3.zip');
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', zip, '-C', src, '.']);
    const root = join(work, 'install');
    mkdirSync(root);
    writeFileSync(join(root, 'install.json'), '{}');

    const folder = withCommon<string>(`Expand-Release ${q(zip)} ${q(root)}`);
    expect(folder).toBe(join(root, 'releases', '2026.11.02-ab12cd3'));
    expect(readdirSync(join(root, 'releases'))).toEqual(['2026.11.02-ab12cd3']);
    expect(withCommon<string>(`Find-InstallRoot ${q(join(folder, 'deploy', 'windows'))}`)).toBe(
      root,
    );
  });

  it('fills the WinSW templates into well-formed XML with no placeholder left', () => {
    const services = withCommon<Record<string, string>>(
      `$v = Get-ServiceXmlValues ([pscustomobject]@{ Root = 'C:\\m100'; Node = 'C:\\Program Files\\nodejs\\node.exe'; PostgresService = 'postgresql-x64-16' }); ` +
        `$o = @{}; foreach ($n in $script:Services) { $x = [xml](Format-ServiceXml (Join-Path ${q(windowsDir)} ($n + '.xml')) $v); ` +
        `$o[$n] = @{ id = $x.service.id; exe = $x.service.executable; args = $x.service.arguments; cwd = $x.service.workingdirectory; ` +
        `depend = ($x.SelectNodes('/service/depend') | ForEach-Object { $_.InnerText }); log = $x.service.log.mode; env = @($x.service.env | ForEach-Object { $_.name + '=' + $_.value }) -join ';' } }; $o`,
    );
    expect(services['m100-api']).toEqual({
      id: 'm100-api',
      exe: 'C:\\Program Files\\nodejs\\node.exe',
      args: '"C:\\m100\\current\\api\\dist\\main.js"',
      cwd: 'C:\\m100',
      depend: 'postgresql-x64-16',
      log: 'roll-by-size-time',
      env: 'NODE_ENV=production',
    });
    expect(services['m100-caddy']).toMatchObject({
      id: 'm100-caddy',
      exe: 'C:\\m100\\caddy\\caddy.exe',
      args: 'run --config "C:\\m100\\current\\deploy\\Caddyfile" --adapter caddyfile --envfile "C:\\m100\\.env"',
      cwd: 'C:\\m100',
      log: 'roll-by-size-time',
      env: 'M100_HOME=C:/m100;XDG_DATA_HOME=C:\\m100\\caddy-data;XDG_CONFIG_HOME=C:\\m100\\caddy-config',
    });
  });
});
