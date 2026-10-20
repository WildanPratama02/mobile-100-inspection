import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256';

const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256Hex', () => {
  it('hashes the bytes of a blob as lowercase hex', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(ABC);
  });

  it('hashes a string as its UTF-8 bytes', async () => {
    expect(await sha256Hex('abc')).toBe(ABC);
    // U+00A0 is two bytes in UTF-8 (doc 02 D12: names pass through byte for byte).
    expect(await sha256Hex('A B')).toBe(await sha256Hex(new Blob(['A B'])));
  });
});
