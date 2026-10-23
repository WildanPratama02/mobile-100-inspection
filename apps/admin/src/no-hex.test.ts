// @vitest-environment node
// Colours come only from the CSS variables in tokens.css (CLAUDE.md UI rules), as in apps/web.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const HEX = /#[0-9a-f]{3,8}\b/gi;
const RGB = /\brgba?\(/gi;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|css)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('apps/admin/src', () => {
  it('has no hex or rgb colour', () => {
    const files = sourceFiles(src);
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          [...(line.match(HEX) ?? []), ...(line.match(RGB) ?? [])].map(
            (m) => `${path.relative(src, file)}:${i + 1} ${m}`,
          ),
        ),
    );
    expect(hits).toEqual([]);
  });
});
