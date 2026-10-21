import type { IssuedDevice } from './device-admin';
import { escapeHtml, setupSheetHtml, terminalQr } from './setup-sheet';
import { parseTabletsCsv } from './tablets-csv';

const device = (label: string, n: number): IssuedDevice => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  label,
  key: `key${n}`.padEnd(43, 'x'),
  link: `https://m100.qdms.web.id/setup#k=${`key${n}`.padEnd(43, 'x')}`,
});

describe('tablets.csv (device:add --batch)', () => {
  it('reads the label column, with a BOM, other columns, blank rows and spaces', () => {
    const csv = '﻿no,Label ,note\r\n1, Tablet F3-01 ,a\r\n\r\n2,Tablet F3-02,\r\n3,,empty\r\n';
    expect(parseTabletsCsv(csv)).toEqual(['Tablet F3-01', 'Tablet F3-02']);
  });

  it('keeps duplicates, so the command can name them', () => {
    expect(parseTabletsCsv('label\nA\nA\n')).toEqual(['A', 'A']);
  });

  it.each([
    ['no label column', 'name\nA\n', /no "label" column/],
    ['no labels', 'label\n\n', /no labels/],
    ['an empty file', '', /no "label" column/],
    ['broken quotes', 'label\n"A\n', /Cannot read the CSV/],
  ])('refuses %s', (_name, csv, message) => {
    expect(() => parseTabletsCsv(csv)).toThrow(message);
  });
});

describe('setup sheet', () => {
  it('has one card per tablet with its label, its link and a QR code', async () => {
    const devices = Array.from({ length: 40 }, (_, i) => device(`Tablet ${i + 1}`, i + 1));
    const html = await setupSheetHtml(devices, new Date('2026-10-21T03:00:00Z'));
    expect(html.match(/<section class="card">/g)).toHaveLength(40);
    expect(html.match(/<svg /g)).toHaveLength(40);
    for (const d of devices) {
      expect(html).toContain(`<h2>${d.label}</h2>`);
      expect(html).toContain(d.link);
    }
    expect(html).toContain('40 tablets');
    expect(html).toContain('2026-10-21T10:00:00.000+07:00');
    // Self-contained: nothing to load from elsewhere.
    expect(html).not.toMatch(/<(script|link)\b|src=/);
  });

  it('escapes the label', async () => {
    const html = await setupSheetHtml([device('<b>"F3" & co</b>', 1)]);
    expect(html).toContain('&lt;b&gt;&quot;F3&quot; &amp; co&lt;/b&gt;');
    expect(html).toContain('1 tablet</h1>');
    expect(escapeHtml(`'`)).toBe('&#39;');
  });

  it('draws a QR code for the terminal', async () => {
    const qr = await terminalQr(device('A', 1).link);
    expect(qr.split('\n').length).toBeGreaterThan(10);
  });
});
