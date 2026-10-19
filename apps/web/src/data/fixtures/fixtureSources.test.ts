import { describe, expect, it } from 'vitest';
import { LoginRejectedError, PO_RESULTS_MAX, PoSearchError } from '../sources';
import { createFixtureSources } from './fixtureSources';
import { DB_CELL, USER_LIST } from './masterSheets';
import { ALL_PO_MASTER } from './pos';

describe('fixture master data', () => {
  it('holds users of other types, which the login list leaves out (AC-01.1)', async () => {
    const types = new Set(USER_LIST.map((r) => r.typeInspection));
    expect(types).toEqual(new Set(['PSI lv.1', 'PSI lv.2', 'CFA', 'T1QM', 'AQL3RD PARTY']));

    const { users } = await createFixtureSources().masterData.getLoginData();
    expect(users).toEqual([
      { username: 'ANDI CONTOH', level: 'PSI lv.1' },
      { username: 'BUNGA CONTOH', level: 'PSI lv.1' },
      { username: 'CAHYA CONTOH', level: 'PSI lv.1' },
      { username: 'DEWI CONTOH', level: 'PSI lv.2' },
      { username: 'EKO CONTOH', level: 'PSI lv.2' },
      { username: 'FAJAR CONTOH', level: 'PSI lv.2' },
    ]);
  });

  it('offers F <number> factories only', async () => {
    expect(DB_CELL.some((r) => r.factory === 'PWA')).toBe(true);
    const { factories } = await createFixtureSources().masterData.getLoginData();
    expect(factories).toEqual([
      { factory: 'F 1', cells: ['F1-01'] },
      { factory: 'F 3', cells: ['F3-10', 'F3-11', 'F3-12'] },
    ]);
  });
});

describe('fixture login', () => {
  const { auth } = createFixtureSources();

  it('logs in a listed PSI to a listed cell', async () => {
    await expect(
      auth.login({ username: 'DEWI CONTOH', level: 'PSI lv.2', factory: 'F 3', cell: 'F3-10' }),
    ).resolves.toEqual({
      username: 'DEWI CONTOH',
      level: 'PSI lv.2',
      factory: 'F 3',
      cell: 'F3-10',
      token: null,
      tokenExpiresAt: null,
    });
  });

  it('refuses a user who is not a PSI with USER_NOT_FOUND', async () => {
    const error = await auth
      .login({ username: 'GITA CONTOH', level: 'PSI lv.1', factory: 'F 3', cell: 'F3-10' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoginRejectedError);
    expect(error).toMatchObject({
      code: 'USER_NOT_FOUND',
      detail: 'Nama tidak ada di daftar PSI.',
    });
  });

  it('refuses a cell of another factory with CELL_NOT_FOUND', async () => {
    const error = await auth
      .login({ username: 'ANDI CONTOH', level: 'PSI lv.1', factory: 'F 1', cell: 'F3-10' })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'CELL_NOT_FOUND',
      detail: 'Factory/Cell tidak ditemukan.',
    });
  });
});

describe('fixture PO search (doc 04 §3.3, FR-03.2)', () => {
  const { pos } = createFixtureSources();

  it('matches PO number, article or model, ignoring case', async () => {
    expect((await pos.search('0902368', 20)).map((p) => p.po)).toEqual([
      'CX-0902368685',
      'CX-0902368700',
    ]);
    expect((await pos.search('ih0003', 20)).map((p) => p.po)).toEqual(['0903359401']);
    expect((await pos.search('skate', 20)).map((p) => p.po)).toEqual([
      'CX-0902368700',
      '0903361120',
    ]);
  });

  it('keeps the leading zero, the prefix and the model byte for byte (AC-03.5)', async () => {
    const [found] = await pos.search('0903359401', 20);
    expect(found).toEqual(ALL_PO_MASTER.find((p) => p.po === '0903359401'));
    expect(found?.model).toBe('RUNNER CONTOH 2');
  });

  it('refuses a query under 3 characters', async () => {
    await expect(pos.search('09', 20)).rejects.toBeInstanceOf(PoSearchError);
  });

  it('returns at most the limit', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...ALL_PO_MASTER[0]!,
      po: `09000000${String(i).padStart(2, '0')}`,
    }));
    const found = await createFixtureSources({ pos: many }).pos.search('0900', PO_RESULTS_MAX);
    expect(found).toHaveLength(20);
  });
});
