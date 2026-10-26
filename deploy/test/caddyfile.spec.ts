import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const deployDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const caddyfile = readFileSync(join(deployDir, 'Caddyfile'), 'utf8');
const securityHeaders = JSON.parse(
  readFileSync(join(deployDir, 'security-headers.json'), 'utf8'),
) as Record<string, string>;

/** The body of the first `<opening> {` block in `text`, braces balanced. */
function block(text: string, opening: string): string {
  const start = text.indexOf(`${opening} {`);
  if (start < 0) throw new Error(`No block "${opening} {"`);
  let depth = 0;
  const open = start + opening.length + 1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`Unbalanced block "${opening}"`);
}

/** `Name "value"` lines of a header block, comments and `-Name` / `defer` skipped. */
function headerLines(body: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of body.split('\n').map((l) => l.trim())) {
    const match = /^([A-Za-z-]+) "(.*)"$/.exec(line);
    if (match) headers[match[1]!] = match[2]!;
  }
  return headers;
}

const site = block(caddyfile, '{$PUBLIC_HOST}');

describe('Caddyfile (doc 03 §6, §7.1, §7.2.1)', () => {
  it('sends the security headers of security-headers.json on every answer, HSTS not yet', () => {
    const headers = block(site, 'header');
    expect(headerLines(headers)).toEqual(securityHeaders);
    expect(securityHeaders['Content-Security-Policy']).toBe(
      "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'",
    );
    expect(headers).toMatch(/^\s*defer$/m);
    expect(headers).toMatch(/^\s*# Strict-Transport-Security/m);
  });

  it('gets its certificate through the Cloudflare DNS challenge and turns the admin endpoint off', () => {
    expect(block(site, 'tls')).toContain('dns cloudflare {env.CF_API_TOKEN}');
    expect(caddyfile).toMatch(/^\{\s*(#.*\s*)*admin off\s*\}/m);
  });

  it('proxies /v1 to the API on loopback, never cached', () => {
    const v1 = block(site, 'handle /v1/*');
    expect(v1).toContain('reverse_proxy 127.0.0.1:3000');
    expect(headerLines(block(v1, 'header'))).toEqual({ 'Cache-Control': 'no-store' });
  });

  it('serves /admin/ from the release with its own fallback; hashed assets immutable, the rest revalidated', () => {
    const admin = block(site, 'handle /admin/*');
    expect(admin).toContain('root * {$M100_HOME}/current');
    expect(admin).toContain('try_files {path} /admin/index.html');
    expect(admin).toContain('@adminAssets path /admin/assets/*');
    expect(admin).toContain(
      'header @adminAssets Cache-Control "public, max-age=31536000, immutable"',
    );
    expect(admin).toContain('@adminShell not path /admin/assets/*');
    expect(admin).toContain('header @adminShell Cache-Control "no-cache"');
  });

  it('serves the PWA with index.html as the fallback; sw.js and index.html revalidated (doc 03 §4.8)', () => {
    const web = block(site, 'handle');
    expect(web).toContain('root * {$M100_HOME}/current/web');
    expect(web).toContain('try_files {path} /index.html');
    expect(web).toContain('header @assets Cache-Control "public, max-age=31536000, immutable"');
    expect(web).toContain('@shell not path /assets/*');
    expect(web).toContain('header @shell Cache-Control "no-cache"');
  });

  it('is the header set the PWA preview runs its end-to-end tests under', () => {
    const viteConfig = readFileSync(join(deployDir, '..', 'apps', 'web', 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain('deploy/security-headers.json');
  });

  // Needs a Caddy with the Cloudflare module; e.g. CADDY_BIN=C:\tools\caddy.exe pnpm --filter deploy test
  it.runIf(process.env.CADDY_BIN)('passes caddy validate', () => {
    const result = spawnSync(
      process.env.CADDY_BIN!,
      ['validate', '--config', join(deployDir, 'Caddyfile'), '--adapter', 'caddyfile'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PUBLIC_HOST: 'm100.qdms.web.id',
          M100_HOME: 'C:/m100',
          CF_API_TOKEN: 'test-token',
        },
      },
    );
    expect(result.stderr + result.stdout).toContain('Valid configuration');
    expect(result.status).toBe(0);
  });
});
