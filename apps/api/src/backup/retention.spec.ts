import { backupName, backupsToDelete, NIGHTLY_RETENTION, PRE_UPGRADE_RETENTION } from './retention';

/** One backup at 01:00 WIB on each day from `first` for `days` days. */
function nightly(first: string, days: number): string[] {
  const start = new Date(`${first}T01:00:00+07:00`);
  return Array.from({ length: days }, (_, i) =>
    backupName(new Date(start.getTime() + i * 86_400_000)),
  );
}

describe('backupName', () => {
  it('is the start time in WIB, also across midnight UTC', () => {
    expect(backupName(new Date('2026-10-26T18:30:05Z'))).toBe('2026-10-27_013005');
    expect(backupName(new Date('2026-12-31T16:59:59Z'))).toBe('2026-12-31_235959');
  });
});

describe('backupsToDelete (doc 03 §7.6)', () => {
  it('keeps 14 daily and the newest of each of 12 months', () => {
    const names = nightly('2025-06-01', 520); // up to 2026-11-01
    const kept = names.filter((n) => !backupsToDelete(names, NIGHTLY_RETENTION).includes(n));

    const daily = names.slice(-14);
    expect(kept).toEqual(expect.arrayContaining(daily));
    // The newest of each month, newest month first; the last 14 days already cover November and part of October.
    const monthly = kept.filter((n) => !daily.includes(n));
    expect(monthly).toEqual([
      '2025-12-31_010000',
      '2026-01-31_010000',
      '2026-02-28_010000',
      '2026-03-31_010000',
      '2026-04-30_010000',
      '2026-05-31_010000',
      '2026-06-30_010000',
      '2026-07-31_010000',
      '2026-08-31_010000',
      '2026-09-30_010000',
    ]);
    expect(kept).toHaveLength(14 + 10);
  });

  it('counts days, not backups: a second backup on one day replaces that day, it does not push out another', () => {
    const names = [...nightly('2026-10-01', 20), '2026-10-20_143000'];
    const deleted = backupsToDelete(names, { daily: 14 });
    expect(deleted).toContain('2026-10-20_010000');
    expect(deleted).not.toContain('2026-10-20_143000');
    expect(deleted).not.toContain('2026-10-07_010000');
    expect(deleted).toContain('2026-10-06_010000');
  });

  it('keeps the last 5 before an upgrade', () => {
    const names = nightly('2026-10-01', 8);
    expect(backupsToDelete(names, PRE_UPGRADE_RETENTION)).toEqual([
      '2026-10-03_010000',
      '2026-10-02_010000',
      '2026-10-01_010000',
    ]);
  });

  it('never deletes a folder that is not a finished backup', () => {
    const names = ['2026-10-01_010000.partial', 'notes', '2026-10-02_010000'];
    expect(backupsToDelete(names, { latest: 0 })).toEqual(['2026-10-02_010000']);
    expect(backupsToDelete(names, PRE_UPGRADE_RETENTION)).toEqual([]);
  });
});
