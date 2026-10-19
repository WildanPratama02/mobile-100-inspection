import { describe, expect, it } from 'vitest';
import {
  fileDate,
  formatCount,
  formatDate,
  formatDateTime,
  formatPartial,
  formatRate,
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
