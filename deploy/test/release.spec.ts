import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEPLOY_FILES, forbiddenPaths, releaseVersion } from '../build-release.mjs';

const deployDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('build-release', () => {
  it('names a release by its WIB date and commit', () => {
    expect(releaseVersion(new Date('2026-11-01T18:30:00Z'), 'ab12cd3', false)).toBe(
      '2026.11.02-ab12cd3',
    );
    expect(releaseVersion(new Date('2026-11-01T16:59:59Z'), 'ab12cd3', true)).toBe(
      '2026.11.01-ab12cd3-dirty',
    );
  });

  it('ships every script and service definition of deploy/windows, and the Caddyfile', () => {
    const windows = readdirSync(join(deployDir, 'windows')).map((f) => `windows/${f}`);
    expect([...DEPLOY_FILES].sort()).toEqual(
      ['Caddyfile', 'security-headers.json', ...windows].sort(),
    );
  });

  describe('forbiddenPaths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm100-release-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('finds .env files and secrets folders anywhere, not .env.example', () => {
      mkdirSync(join(dir, 'api', 'secrets'), { recursive: true });
      mkdirSync(join(dir, 'web'), { recursive: true });
      writeFileSync(join(dir, 'api', '.env'), 'X=1');
      writeFileSync(join(dir, 'api', '.env.local'), 'X=1');
      writeFileSync(join(dir, '.env.example'), 'X=');
      writeFileSync(join(dir, 'web', 'index.html'), '');
      expect(forbiddenPaths(dir).sort()).toEqual(['api/.env', 'api/.env.local', 'api/secrets']);
    });
  });
});
