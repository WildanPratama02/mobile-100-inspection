import { describe, expect, it } from 'vitest';
import { APP_NAME } from './index';

describe('@m100/shared', () => {
  it('exposes the product name of ADR-010', () => {
    expect(APP_NAME).toBe('Mobile 100% Inspection');
  });
});
