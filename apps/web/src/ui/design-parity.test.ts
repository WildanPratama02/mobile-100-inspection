// @vitest-environment node
// The port must stay in step with the design system it was copied from (design-system/).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHOE_AREAS, SHOE_BOX } from './shoeLayout';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (...parts: string[]) =>
  readFileSync(path.join(repo, ...parts), 'utf8').replace(/\r\n/g, '\n');

const GOOGLE_FONTS = /^@import url\('https:\/\/fonts\.googleapis\.com[^\n]*\n/m;

describe('tokens.css', () => {
  it('equals design-system/tokens.css without the Google Fonts @import', () => {
    const source = read('design-system', 'tokens.css');
    expect(source).toMatch(GOOGLE_FONTS);
    expect(read('apps', 'web', 'src', 'ui', 'tokens.css')).toBe(source.replace(GOOGLE_FONTS, ''));
  });
});

describe('ShoeMap layout', () => {
  const bundle = read('design-system', 'components', 'bundle.js');

  it('uses the image box of bundle.js', () => {
    const box = /var SHOE_BOX = (\[[^\]]*\]);/.exec(bundle);
    expect(box).not.toBeNull();
    expect(SHOE_BOX).toEqual(JSON.parse(box![1]!));
  });

  it('uses the 12 anchors, docks and sides of bundle.js', () => {
    const block = /var SHOE_AREAS = \[([\s\S]*?)\n\];/.exec(bundle);
    expect(block).not.toBeNull();
    // Turn the JS object literals into JSON: quote keys, swap quotes.
    const json = `[${block![1]!}]`.replace(/([{,]\s*)([a-z]+):/g, '$1"$2":').replace(/'/g, '"');
    const expected = JSON.parse(json) as Array<Record<string, unknown>>;
    expect(expected).toHaveLength(12);
    expect(SHOE_AREAS).toEqual(expected);
  });
});
