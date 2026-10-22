import { describe, expect, it } from 'vitest';
import {
  fileDate,
  formatCount,
  formatDate,
  formatDateTime,
  formatDisplayNo,
  formatPartial,
  formatRate,
  formatDayTime,
  formatTime,
  inspectionDate,
  partialText,
  toWibIso,
} from './format';

describe('formatRate (BR-02, doc 05 G5)', () => {
  it('shows "—" when the rate cannot be computed', () => {
    expect(formatRate(null)).toBe('—');
  });

  it('shows one decimal in id-ID', () => {
    expect(formatRate(3 / 16)).toBe('18,8%');
    expect(formatRate(0)).toBe('0,0%');
    expect(formatRate(1)).toBe('100,0%');
    expect(formatRate(0.05)).toBe('5,0%');
  });

  it('shows a defect rate above 100%', () => {
    expect(formatRate(2.5)).toBe('250,0%');
  });
});

describe('formatCount', () => {
  it('groups thousands with a dot', () => {
    expect(formatCount(2400)).toBe('2.400');
    expect(formatCount(10002)).toBe('10.002');
    expect(formatCount(0)).toBe('0');
  });
});

describe('formatPartial (doc 05 §15)', () => {
  it('shows the partial number, its quantity and Qty Order', () => {
    expect(formatPartial({ number: 1, qty: 1200 }, 10002)).toBe('P1 · 1.200 dari 10.002');
    expect(formatPartial({ number: 12, qty: 5 }, 5)).toBe('P12 · 5 dari 5');
  });
});

describe('partialText (doc 02 §4.1)', () => {
  it('shows the sheet value with Indonesian thousands', () => {
    expect(partialText({ number: 1, qty: 1200 }, 10002)).toBe('P1 1.200 OF 10.002');
    expect(partialText({ number: 12, qty: 5 }, 999)).toBe('P12 5 OF 999');
    expect(partialText({ number: 99, qty: 1234567 }, 1234567)).toBe('P99 1.234.567 OF 1.234.567');
  });
});

describe('formatDisplayNo (doc 02 §4.1)', () => {
  it('pads to six digits behind M100-', () => {
    expect(formatDisplayNo(123)).toBe('M100-000123');
    expect(formatDisplayNo(1)).toBe('M100-000001');
    expect(formatDisplayNo(1234567)).toBe('M100-1234567');
  });
});

describe('formatDate (doc 05 §9.1)', () => {
  it('shows a PO date as dd MMM yyyy in id-ID', () => {
    expect(formatDate('2026-10-16')).toBe('16 Okt 2026');
    expect(formatDate('2027-01-05')).toBe('05 Jan 2027');
  });

  it('shows "-" for an empty or unreadable date', () => {
    expect(formatDate(null)).toBe('-');
    expect(formatDate('16/10/2026')).toBe('-');
    expect(formatDate('2026-02-30')).toBe('-');
  });
});

describe('formatDateTime (WIB)', () => {
  it('shows the moment in Asia/Jakarta as dd MMM yyyy HH.mm WIB', () => {
    expect(formatDateTime(new Date('2026-10-19T07:05:00Z'))).toBe('19 Okt 2026 14.05 WIB');
    expect(formatDateTime(new Date('2026-05-01T00:00:00Z'))).toBe('01 Mei 2026 07.00 WIB');
  });

  it('moves to the next day from 17.00 UTC', () => {
    expect(formatDateTime(new Date('2026-12-31T17:30:00Z'))).toBe('01 Jan 2027 00.30 WIB');
  });
});

describe('fileDate (AC-12.3)', () => {
  it('gives the WIB calendar day as YYYYMMDD', () => {
    expect(fileDate(new Date('2026-10-19T07:05:00Z'))).toBe('20261019');
    expect(fileDate(new Date('2026-10-19T16:59:59Z'))).toBe('20261019');
    expect(fileDate(new Date('2026-10-19T17:00:00Z'))).toBe('20261020');
  });
});

describe('inspectionDate (doc 02 §6.4)', () => {
  it('gives the WIB calendar date of sealedAt', () => {
    expect(inspectionDate('2026-10-16T14:32:05+07:00')).toBe('2026-10-16');
    expect(inspectionDate('2026-10-16T00:00:00+07:00')).toBe('2026-10-16');
    expect(inspectionDate(new Date('2026-10-16T16:59:59.999Z'))).toBe('2026-10-16');
  });

  it('moves to the next day from 17:00 UTC', () => {
    expect(inspectionDate('2026-10-31T17:30:00Z')).toBe('2026-11-01');
    expect(inspectionDate('2026-12-31T17:00:00.000Z')).toBe('2027-01-01');
  });

  it('refuses something that is not a moment', () => {
    expect(() => inspectionDate('kemarin')).toThrow(RangeError);
  });
});

describe('toWibIso (doc 04 §1)', () => {
  it('writes the moment with the +07:00 offset, milliseconds kept', () => {
    expect(toWibIso('2026-10-16T07:32:05.123Z')).toBe('2026-10-16T14:32:05.123+07:00');
    expect(toWibIso(new Date('2026-10-16T07:32:05Z'))).toBe('2026-10-16T14:32:05.000+07:00');
  });

  it('names the same moment', () => {
    const at = '2026-12-31T17:30:00.250Z';
    expect(toWibIso(at)).toBe('2027-01-01T00:30:00.250+07:00');
    expect(Date.parse(toWibIso(at))).toBe(Date.parse(at));
  });

  it('refuses something that is not a moment', () => {
    expect(() => toWibIso('kemarin')).toThrow(RangeError);
  });
});

describe('formatTime (doc 05 G5)', () => {
  it('shows WIB HH:mm', () => {
    expect(formatTime('2026-10-16T07:32:05Z')).toBe('14:32');
    expect(formatTime(new Date('2026-10-19T17:05:00Z'))).toBe('00:05');
    expect(formatTime('2026-10-19T00:00:00Z')).toBe('07:00');
  });
});

describe('formatDayTime (doc 05 §14, AC-13.4)', () => {
  it('shows the WIB day, month and time', () => {
    expect(formatDayTime('2026-10-21T07:05:00Z')).toBe('21 Okt 14:05');
    // 17:30 UTC is already the next day in WIB.
    expect(formatDayTime(new Date('2026-10-21T17:30:00Z'))).toBe('22 Okt 00:30');
  });
});
