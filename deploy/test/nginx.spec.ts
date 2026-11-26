import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const deployDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(join(deployDir, file), 'utf8');
const conf = read('linux/m100.conf');
const snippet = read('linux/m100-headers.conf');
const securityHeaders = JSON.parse(read('security-headers.json')) as Record<string, string>;
const cacheControl = JSON.parse(read('cache-control.json')) as {
  hashedAssets: string;
  appShell: string;
  api: string;
};

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

/** Active (not commented) `add_header Name "value" always;` lines. */
function addHeaders(body: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of body.split('\n').map((l) => l.trim())) {
    const match = /^add_header ([A-Za-z-]+) "(.*)" always;$/.exec(line);
    if (match) headers[match[1]!] = match[2]!;
  }
  return headers;
}

/** The HTTPS server block: everything after its `listen 443 ssl;` line up to the matching brace. */
const tls = block(conf.slice(conf.indexOf('listen 443 ssl;') - 'server {\n    '.length), 'server');

describe('linux/m100.conf', () => {
  it('has the same security headers as security-headers.json', () => {
    expect(addHeaders(snippet)).toEqual(securityHeaders);
  });

  it('listens on 443 for m100.qdms.web.id and redirects port 80 to HTTPS', () => {
    expect(tls).toContain('server_name m100.qdms.web.id;');
    expect(conf).toMatch(/listen 80;[\s\S]*return 301 https:\/\/\$host\$request_uri;/);
  });

  it('proxies /v1/ to the same loopback port as PORT in env.example and the unit', () => {
    expect(block(conf, 'upstream m100_api')).toContain('server 127.0.0.1:3110;');
    expect(read('linux/env.example')).toMatch(/^PORT=3110$/m);
    expect(read('linux/m100-api.service')).toContain('127.0.0.1:3110');
    expect(block(tls, 'location /v1/')).toContain('proxy_pass http://m100_api;');
  });

  it('overwrites X-Forwarded-For with the client address and allows 100 MB bodies', () => {
    expect(block(tls, 'location /v1/')).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(tls).toContain('client_max_body_size 100m;');
  });

  it('includes the header snippet in every location, because add_header does not inherit', () => {
    // `location = /admin { return 308 /admin/; }` only redirects and sends no body.
    const openings = [...tls.matchAll(/(location [^{;]+?)\s*\{/g)]
      .map((m) => m[1]!)
      .filter((l) => l !== 'location = /admin');
    expect(openings).toEqual([
      'location /v1/',
      'location /admin/assets/',
      'location /admin/',
      'location /assets/',
      'location /',
    ]);
    for (const opening of openings) {
      expect(block(tls, opening), opening).toContain('include snippets/m100-headers.conf;');
    }
  });

  it('uses the cache rules of cache-control.json', () => {
    const cache = (opening: string) =>
      /add_header Cache-Control "([^"]+)" always;/.exec(block(tls, opening))?.[1];
    expect(cache('location /v1/')).toBe(cacheControl.api);
    expect(cache('location /assets/')).toBe(cacheControl.hashedAssets);
    expect(cache('location /admin/assets/')).toBe(cacheControl.hashedAssets);
    expect(cache('location /admin/')).toBe(cacheControl.appShell);
    expect(cache('location /')).toBe(cacheControl.appShell);
  });

  it('serves the tablet app and the admin app from the release folders', () => {
    expect(block(tls, 'location /')).toContain('root /opt/m100/current/web;');
    expect(block(tls, 'location /')).toContain('try_files $uri /index.html;');
    expect(block(tls, 'location /admin/')).toContain('root /opt/m100/current;');
    expect(block(tls, 'location /admin/')).toContain('try_files $uri /admin/index.html;');
  });

  it('is accepted by nginx when NGINX_BIN is set', () => {
    const nginx = process.env['NGINX_BIN'];
    if (!nginx) return;
    // The certificate paths do not exist on a developer machine: only syntax errors count.
    const result = spawnSync(nginx, ['-t', '-c', join(deployDir, 'linux', 'm100.conf')], {
      encoding: 'utf8',
    });
    expect(result.stderr).not.toMatch(/unexpected|unknown directive/);
  });
});
