/**
 * Turns a camera photo into the JPEG the tablet stores and submits (AC-10.1, doc 03 §4.5): at most 960 px
 * on the long edge, re-encoded as JPEG of at most 1 MB, with its SHA-256 for the submission (doc 04 §4.1).
 * Runs on the tablet only; the server never re-encodes.
 */
import { sha256Hex } from '../app/sha256';
import type { Jpeg } from '../state/store';

/** AC-10.1. */
export const MAX_EDGE = 960;
/** AC-10.1 and the API's limit per photo part (doc 04 §4.2, §8). */
export const MAX_BYTES = 1_000_000;
/** Tried in order until the file fits; the first gives ≈ 100–200 KB at 960 px (doc 03 §4.5). */
export const QUALITIES = [0.8, 0.7, 0.6, 0.5, 0.4, 0.3] as const;

export class PhotoProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoProcessingError';
  }
}

/** The size to draw at: the long edge at most `max`, aspect kept, never enlarged. */
export function fitWithin(
  width: number,
  height: number,
  max: number = MAX_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Encodes at falling quality until the JPEG is at most `maxBytes`. */
export async function encodeWithin(
  encode: (quality: number) => Promise<Blob>,
  maxBytes: number = MAX_BYTES,
): Promise<Blob> {
  for (const quality of QUALITIES) {
    const blob = await encode(quality);
    if (blob.size <= maxBytes) return blob;
  }
  throw new PhotoProcessingError(`JPEG stays above ${maxBytes} bytes`);
}

function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob?.type === 'image/jpeg') resolve(blob);
        else reject(new PhotoProcessingError('The browser did not encode a JPEG'));
      },
      'image/jpeg',
      quality,
    );
  });
}

/**
 * Decodes the photo upright (EXIF orientation applied, the EXIF itself dropped), draws it at most 960 px on
 * the long edge and encodes it as JPEG.
 */
export async function toJpeg(file: Blob): Promise<Jpeg> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new PhotoProcessingError('No 2D canvas');
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await encodeWithin((quality) => canvasJpeg(canvas, quality));
    return { blob, sha256: await sha256Hex(blob) };
  } finally {
    bitmap.close();
  }
}
