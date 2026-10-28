import { createHmac, randomBytes } from 'node:crypto';
import { tamperSignature } from './tamper';

describe('tamperSignature', () => {
  it('always changes the decoded signature bytes and nothing before it', () => {
    for (let i = 0; i < 5000; i++) {
      const signature = createHmac('sha256', randomBytes(32)).update('x').digest('base64url');
      const token = `header.payload.${signature}`;
      const tampered = tamperSignature(token);
      expect(tampered.startsWith('header.payload.')).toBe(true);
      expect(tampered).toHaveLength(token.length);
      const before = Buffer.from(signature, 'base64url');
      const after = Buffer.from(tampered.split('.')[2]!, 'base64url');
      expect(after.equals(before)).toBe(false);
    }
  });

  it('changes exactly one character', () => {
    const token = 'h.p.' + 'A'.repeat(43);
    const tampered = tamperSignature(token);
    expect([...tampered].filter((c, i) => c !== token[i])).toEqual(['B']);
  });
});
