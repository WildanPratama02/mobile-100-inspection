import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMigrationsDir, listMigrations } from './migrate';

describe('listMigrations (T2.2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'm100-migrations-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('gives a CRLF copy of a file the same checksum as the LF original', () => {
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;\nSELECT 2;\n');
    const lf = listMigrations(dir)[0];
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;\r\nSELECT 2;\r\n');
    const crlf = listMigrations(dir)[0];

    expect(crlf).toEqual(lf);
  });

  it('returns the .sql files in version order with the SHA-256 of their text', () => {
    writeFileSync(join(dir, '0002_b.sql'), 'SELECT 2;');
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;');
    writeFileSync(join(dir, 'README.md'), 'not a migration');

    const list = listMigrations(dir);

    expect(list.map((m) => m.version)).toEqual(['0001_a', '0002_b']);
    expect(list[0]?.sql).toBe('SELECT 1;');
    expect(list[0]?.sha256).toBe(createHash('sha256').update('SELECT 1;').digest('hex'));
  });

  it('refuses a file whose name is not 0000_name.sql', () => {
    writeFileSync(join(dir, 'add-users.sql'), 'SELECT 1;');
    expect(() => listMigrations(dir)).toThrow('add-users.sql');
  });

  it('reads the repository migrations, numbered without gaps', () => {
    const versions = listMigrations().map((m) => Number(m.version.slice(0, 4)));
    expect(versions.length).toBeGreaterThanOrEqual(5);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
  });
});

describe('findMigrationsDir (T2.2)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'm100-release-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds db/migrations in the nearest ancestor, as from a release folder', () => {
    mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
    mkdirSync(join(root, 'api', 'dist', 'cli'), { recursive: true });
    expect(findMigrationsDir(join(root, 'api', 'dist', 'cli'))).toBe(
      join(root, 'db', 'migrations'),
    );
  });
});
