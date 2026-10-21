/**
 * `pnpm device:add --label "<label>" [--out <sheet.html>]` or `pnpm device:add --batch <tablets.csv> --out
 * <sheet.html>` (doc 03 §4.9, §7.5): registers tablets and prints each key, its setup link and a QR code **once**.
 * The batch form writes one printable sheet of QR codes. Needs `DATABASE_URL` and `PUBLIC_HOST`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  addDevices,
  DeviceCommandError,
  type IssuedDevice,
  pgDeviceAdminRepositories,
} from '../devices/device-admin';
import { setupSheetHtml, terminalQr } from '../devices/setup-sheet';
import { parseTabletsCsv } from '../devices/tablets-csv';
import { fromInvocationDir, loadCliEnv, openDatabase, requireEnv } from './device-env';

const USAGE = `Usage: pnpm device:add --label "<label>" [--out <sheet.html>]
       pnpm device:add --batch <tablets.csv> --out <sheet.html>`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      label: { type: 'string' },
      batch: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (Boolean(values.label) === Boolean(values.batch)) {
    throw new DeviceCommandError(`Give either --label or --batch\n${USAGE}`);
  }
  if (values.batch && !values.out) throw new DeviceCommandError(`--batch needs --out\n${USAGE}`);
  const labels = values.batch
    ? parseTabletsCsv(readFileSync(fromInvocationDir(values.batch)))
    : [values.label!];
  const out = values.out ? fromInvocationDir(values.out) : undefined;
  // Checked before anything is written: a key that cannot be printed is lost.
  if (out && existsSync(out)) throw new DeviceCommandError(`${out} already exists`);
  if (out && !existsSync(dirname(out))) {
    throw new DeviceCommandError(`Folder ${dirname(out)} does not exist`);
  }

  loadCliEnv();
  const host = requireEnv('PUBLIC_HOST');
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) {
    throw new DeviceCommandError(
      `PUBLIC_HOST must be a host name such as m100.qdms.web.id, not ${host}`,
    );
  }
  const db = openDatabase('device:add');
  let issued: IssuedDevice[];
  try {
    issued = await addDevices(db, pgDeviceAdminRepositories(db), labels, host);
  } finally {
    await db.end();
  }

  const print = (line = '') => process.stdout.write(`${line}\n`);
  print(
    `Registered ${issued.length} ${issued.length === 1 ? 'tablet' : 'tablets'}. Keys are shown only now.`,
  );
  if (out) {
    try {
      writeFileSync(out, await setupSheetHtml(issued), { flag: 'wx' });
      print(`Setup sheet: ${out}`);
      print(
        'It holds the device keys: print it, set up the tablets, then delete the file and destroy the paper.',
      );
    } catch (error) {
      print(`Could not write ${out} (${(error as Error).message}); the links follow instead.`);
      for (const device of issued) print(`  ${device.label}  ${device.link}`);
    }
  }
  if (!values.batch) {
    const [device] = issued as [IssuedDevice];
    print();
    print(`Label:      ${device.label}`);
    print(`Device id:  ${device.id}`);
    print(`Key:        ${device.key}`);
    print(`Setup link: ${device.link}`);
    print();
    print(await terminalQr(device.link));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`device:add failed: ${(error as Error).message}\n`);
  process.exit(1);
});
