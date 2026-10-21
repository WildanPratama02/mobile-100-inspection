/**
 * The QR codes of `device:add` (doc 03 §4.9, §7.5): a printable HTML sheet with one card per tablet (label, QR code
 * of the setup link, the link as text), and a QR code for the terminal. Both hold device keys, so whoever prints
 * the sheet destroys it after the tablets are set up.
 */
import { toWibIso } from '@m100/shared';
import { toString as qrToString } from 'qrcode';
import type { IssuedDevice } from './device-admin';

export async function terminalQr(link: string): Promise<string> {
  return qrToString(link, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
}

/** A self-contained A4 page (no external files), printed from any browser. */
export async function setupSheetHtml(
  devices: readonly IssuedDevice[],
  now = new Date(),
): Promise<string> {
  const cards = await Promise.all(
    devices.map(async (device) => {
      const svg = await qrToString(device.link, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 1,
      });
      return `  <section class="card">
    <h2>${escapeHtml(device.label)}</h2>
    ${svg}
    <p class="link">${escapeHtml(device.link)}</p>
  </section>`;
    }),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>M100 tablet setup sheet</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: system-ui, sans-serif; color: #000; background: #fff; margin: 0; }
  header { margin-bottom: 6mm; }
  header h1 { font-size: 16pt; margin: 0 0 2mm; }
  header p { margin: 0; font-size: 9pt; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; }
  .card { border: 1px solid #000; padding: 4mm; break-inside: avoid; text-align: center; }
  .card h2 { font-size: 12pt; margin: 0 0 2mm; }
  .card svg { width: 45mm; height: 45mm; }
  .link { font-family: ui-monospace, monospace; font-size: 6.5pt; word-break: break-all; margin: 2mm 0 0; }
</style>
</head>
<body>
<header>
  <h1>M100 tablet setup: ${devices.length} ${devices.length === 1 ? 'tablet' : 'tablets'}</h1>
  <p>Created ${escapeHtml(toWibIso(now))}. Each code holds the tablet's device key. Scan it with the tablet's camera
  and open the link in Chrome (doc 03 §7.5), then destroy this sheet.</p>
</header>
<main class="grid">
${cards.join('\n')}
</main>
</body>
</html>
`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
