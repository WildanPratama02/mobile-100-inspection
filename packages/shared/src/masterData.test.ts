import { describe, expect, it } from 'vitest';
import { loginFactories, loginUsers } from './masterData';

describe('loginUsers (doc 02 §3.1)', () => {
  it('lists only PSI lv.1 and PSI lv.2 users (AC-01.1)', () => {
    const users = loginUsers([
      { username: 'UJI CFA', typeInspection: 'CFA' },
      { username: 'UJI T1QM', typeInspection: 'T1QM' },
      { username: 'UJI AQL', typeInspection: 'AQL3RD PARTY' },
      { username: 'UJI SATU', typeInspection: 'PSI lv.1' },
      { username: 'UJI DUA', typeInspection: 'PSI lv.2' },
    ]);
    expect(users).toEqual([
      { username: 'UJI DUA', level: 'PSI lv.2' },
      { username: 'UJI SATU', level: 'PSI lv.1' },
    ]);
  });

  it('shows a name listed twice with the same type once', () => {
    const users = loginUsers([
      { username: 'UJI SATU', typeInspection: 'PSI lv.1' },
      { username: 'UJI SATU', typeInspection: 'PSI lv.1' },
    ]);
    expect(users).toEqual([{ username: 'UJI SATU', level: 'PSI lv.1' }]);
  });

  it('shows a CFA who is also PSI lv.1 once, as PSI lv.1', () => {
    const users = loginUsers([
      { username: 'UJI GANDA', typeInspection: 'CFA' },
      { username: 'UJI GANDA', typeInspection: 'PSI lv.1' },
    ]);
    expect(users).toEqual([{ username: 'UJI GANDA', level: 'PSI lv.1' }]);
  });

  it('shows a name at both PSI levels once per level', () => {
    const users = loginUsers([
      { username: 'UJI DUA LEVEL', typeInspection: 'PSI lv.2' },
      { username: 'UJI DUA LEVEL', typeInspection: 'PSI lv.1' },
    ]);
    expect(users).toEqual([
      { username: 'UJI DUA LEVEL', level: 'PSI lv.1' },
      { username: 'UJI DUA LEVEL', level: 'PSI lv.2' },
    ]);
  });

  it('sorts A–Z', () => {
    const names = loginUsers([
      { username: 'CITRA', typeInspection: 'PSI lv.1' },
      { username: 'ADI', typeInspection: 'PSI lv.2' },
      { username: 'BUDI', typeInspection: 'PSI lv.1' },
    ]).map((u) => u.username);
    expect(names).toEqual(['ADI', 'BUDI', 'CITRA']);
  });
});

describe('loginFactories (doc 02 §3.2)', () => {
  it('offers only F <number> factories, in sheet order, with their cells', () => {
    const factories = loginFactories([
      { factory: 'F 3', cell: 'F3-10' },
      { factory: 'PWA', cell: 'PWA' },
      { factory: 'F 1', cell: 'F1-01' },
      { factory: 'F 3', cell: 'F3-11' },
      { factory: 'BOTTOM', cell: '-' },
      { factory: 'F 6', cell: 'F6-01' },
    ]);
    expect(factories).toEqual([
      { factory: 'F 3', cells: ['F3-10', 'F3-11'] },
      { factory: 'F 1', cells: ['F1-01'] },
      { factory: 'F 6', cells: ['F6-01'] },
    ]);
  });

  it('lists a cell once', () => {
    expect(
      loginFactories([
        { factory: 'F 2', cell: 'F2-01' },
        { factory: 'F 2', cell: 'F2-01' },
      ]),
    ).toEqual([{ factory: 'F 2', cells: ['F2-01'] }]);
  });
});
