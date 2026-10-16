// @vitest-environment node
// Colours come only from the CSS variables in tokens.css (CLAUDE.md UI rules, T0.4).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TOKENS = path.join(src, 'ui', 'tokens.css');
const HEX = /#[0-9a-f]{3,8}\b/gi;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [full] : [];
  });
}

describe('apps/web/src', () => {
  it('has no hex colour outside tokens.css', () => {
    const files = sourceFiles(src).filter((f) => f !== TOKENS);
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          (line.match(HEX) ?? []).map((m) => `${path.relative(src, file)}:${i + 1} ${m}`),
        ),
    );
    expect(hits).toEqual([]);
  });
});
