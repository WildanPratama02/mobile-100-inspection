import { describe, expect, it, vi } from 'vitest';
import {
  encodeWithin,
  fitWithin,
  MAX_BYTES,
  PhotoProcessingError,
  QUALITIES,
  sha256Hex,
} from './resize';

describe('fitWithin (AC-10.1)', () => {
  it('scales a landscape photo to 960 px wide', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 960, height: 720 });
  });

  it('scales a portrait photo to 960 px high', () => {
    expect(fitWithin(3000, 4000)).toEqual({ width: 720, height: 960 });
  });

  it('keeps a photo of exactly 960 px', () => {
    expect(fitWithin(960, 540)).toEqual({ width: 960, height: 540 });
  });

  it('never enlarges a small photo', () => {
    expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480 });
  });
});

describe('encodeWithin (AC-10.1)', () => {
  const ofSize = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });

  it('keeps the first quality when the JPEG fits', async () => {
    const encode = vi.fn(() => Promise.resolve(ofSize(150_000)));
    expect((await encodeWithin(encode)).size).toBe(150_000);
    expect(encode).toHaveBeenCalledExactlyOnceWith(QUALITIES[0]);
  });

  it('lowers the quality until the JPEG is at most 1 MB', async () => {
    const encode = vi.fn((q: number) =>
      Promise.resolve(ofSize(q > 0.55 ? MAX_BYTES + 1 : MAX_BYTES)),
    );
    expect((await encodeWithin(encode)).size).toBe(MAX_BYTES);
    expect(encode.mock.calls.map(([q]) => q)).toEqual([0.8, 0.7, 0.6, 0.5]);
  });

  it('fails when no quality fits', async () => {
    await expect(encodeWithin(() => Promise.resolve(ofSize(MAX_BYTES + 1)))).rejects.toThrow(
      PhotoProcessingError,
    );
  });
});

describe('sha256Hex', () => {
  it('hashes the bytes as lowercase hex', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
