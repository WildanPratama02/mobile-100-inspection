import { describe, expect, it } from 'vitest';
import { actorName, auditSummary, moment, rate, todayWib } from './format';
import { filterFromQuery, filterQuery } from './screens/Submissions';
import { countsText } from './screens/ImportFlow';

describe('rate', () => {
  it('formats a fraction id-ID with one decimal, "—" when Qty Inspection is 0 (BR-02)', () => {
    expect(rate(0.1875, 16)).toBe('18,8%');
    expect(rate(0, 0)).toBe('—');
  });
});

describe('moment / todayWib', () => {
  it('shows moments in WIB', () => {
    expect(moment('2026-10-23T07:05:00Z')).toBe('23 Okt 2026 14.05 WIB');
    expect(moment(null)).toBe('—');
  });
  it('takes today as the WIB day', () => {
    expect(todayWib(new Date('2026-10-23T18:30:00Z'))).toBe('2026-10-24');
  });
});

describe('auditSummary', () => {
  it('shows changed fields as old → new', () => {
    expect(
      auditSummary({
        old: { username: 'Budi', active: true },
        new: { username: 'Budi S', active: false },
      }),
    ).toBe('username: Budi → Budi S; active: ya → tidak');
  });
  it('shows a new row and extra keys', () => {
    expect(auditSummary({ new: { username: 'Ani', level: 'PSI lv.2' } })).toBe(
      'username: Ani; level: PSI lv.2',
    );
    expect(auditSummary({ username: 'qip', old: { active: true }, new: { active: false } })).toBe(
      'username: qip; active: ya → tidak',
    );
    expect(auditSummary({ inserted: 3, masterVersion: '12' })).toBe(
      'inserted: 3; masterVersion: 12',
    );
  });
  it('is empty without details', () => {
    expect(auditSummary(null)).toBe('');
  });
  it('names admins without the prefix', () => {
    expect(actorName('admin:qip.digital')).toBe('qip.digital');
    expect(actorName('script:import-master')).toBe('script:import-master');
  });
});

describe('submission filter in the URL', () => {
  const today = '2026-10-23';
  it('defaults both dates to today (doc 05 §20.3)', () => {
    expect(filterFromQuery(new URLSearchParams(''), today)).toEqual({
      from: today,
      to: today,
      factory: '',
      cell: '',
      username: '',
      po: '',
    });
  });
  it('keeps an emptied date empty and round-trips', () => {
    const filter = {
      from: '',
      to: '2026-10-20',
      factory: 'F 3',
      cell: 'F3-10',
      username: '',
      po: '1234',
    };
    const query = filterQuery(filter, 2);
    expect(query).toBe('?from=&to=2026-10-20&factory=F+3&cell=F3-10&po=1234&page=2');
    expect(filterFromQuery(new URLSearchParams(query), today)).toEqual(filter);
  });
});

describe('countsText', () => {
  it('reads like the report (doc 05 §20.5)', () => {
    expect(countsText({ read: 1200, inserted: 3, updated: 2, skipped: 1195 })).toBe(
      '1.200 dibaca, 3 baru, 2 diubah, 1.195 dilewati',
    );
  });
});
