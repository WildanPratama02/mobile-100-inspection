import { describe, expect, it } from 'vitest';
import { formatCount, formatRate } from './format';

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
