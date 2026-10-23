import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  verifyDummy,
  verifyPassword,
} from './passwords';

describe('admin passwords (doc 03 §6, doc 04 §8)', () => {
  it('hashes with argon2id and a fresh salt each time', async () => {
    const first = await hashPassword('correct horse battery');
    const second = await hashPassword('correct horse battery');
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('correct horse battery');
  });

  it('verifies the right password only', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword(stored, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(stored, 'correct horse batterY')).toBe(false);
    expect(await verifyPassword('not a hash', 'correct horse battery')).toBe(false);
    expect(await verifyDummy('correct horse battery')).toBe(false);
  });

  it(`wants at least ${MIN_PASSWORD_LENGTH} characters, counted as characters, not bytes`, () => {
    expect(passwordProblem('admin123')).toBe('Password minimal 10 karakter.');
    expect(passwordProblem('a'.repeat(9))).toBe('Password minimal 10 karakter.');
    expect(passwordProblem('😀'.repeat(9))).toBe('Password minimal 10 karakter.');
    expect(passwordProblem('a'.repeat(10))).toBeNull();
    expect(passwordProblem('a'.repeat(MAX_PASSWORD_LENGTH))).toBeNull();
    expect(passwordProblem('a'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe(
      `Password maksimal ${MAX_PASSWORD_LENGTH} karakter.`,
    );
  });
});
