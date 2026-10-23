import { isCalendarDate, isoDate } from './admin-input';

describe('isCalendarDate', () => {
  it.each(['2026-10-23', '2028-02-29', '2000-02-29', '1999-12-31', '0001-01-01'])(
    'accepts %s',
    (s) => {
      expect(isCalendarDate(s)).toBe(true);
    },
  );

  it.each([
    'x',
    '',
    '17-10-2026',
    '2026-1-01',
    '2026-10-17T00:00:00Z',
    ' 2026-10-17',
    '2026-02-30',
    '2027-02-29',
    '1900-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-10-32',
    '0000-01-01',
  ])('refuses %j without throwing', (s) => {
    expect(isCalendarDate(s)).toBe(false);
  });
});

describe('isoDate', () => {
  it('reports one issue for a malformed date', () => {
    const parsed = isoDate.safeParse('x');
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues).toHaveLength(1);
  });
});
