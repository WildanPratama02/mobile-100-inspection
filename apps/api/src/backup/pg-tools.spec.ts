import { join } from 'node:path';
import { pgToolPath, splitPassword } from './pg-tools';

describe('splitPassword', () => {
  it('moves the password out of the URL, decoded', () => {
    expect(splitPassword('postgres://m100_migrate:p%40ss@127.0.0.1:5432/m100')).toEqual({
      url: 'postgres://m100_migrate@127.0.0.1:5432/m100',
      password: 'p@ss',
    });
    expect(splitPassword('postgres://postgres@127.0.0.1:5432/m100').password).toBeUndefined();
  });

  it('writes a space in a query parameter as %20, which libpq decodes (it does not decode +)', () => {
    const url = new URL('postgres://u:p@127.0.0.1:5432/m100_test_x');
    url.searchParams.set('options', '-c role=m100_migrate');
    expect(url.href).toContain('options=-c+role');
    expect(splitPassword(url.href).url).toBe(
      'postgres://u@127.0.0.1:5432/m100_test_x?options=-c%20role%3Dm100_migrate',
    );
  });
});

describe('pgToolPath', () => {
  it('uses PG_BIN when set, else the name on PATH', () => {
    expect(pgToolPath('pg_dump', undefined)).toBe('pg_dump');
    const exe = process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore';
    expect(pgToolPath('pg_restore', join('C:', 'pg', 'bin'))).toBe(join('C:', 'pg', 'bin', exe));
  });
});
