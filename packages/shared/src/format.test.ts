import { describe, expect, it } from 'vitest';
import { formatCount, formatDate, formatPartial, formatRate } from './format';

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
