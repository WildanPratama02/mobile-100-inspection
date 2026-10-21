/**
 * What the CLI `device:add`, `device:revoke` and `device:list` do (doc 03 §7.5, ADR-014). Each writes an
 * `audit_log` row (`script:device:<command>`) in the transaction of its change. Keys are generated here and
 * returned once; only their SHA-256 reaches the database, and neither the key nor its hash goes into the audit log.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database';
import {
  PgAuditLogRepository,
  type AuditLogRepository,
} from '../repositories/audit-log.repository';
import {
  type Device,
  type DeviceRepository,
  PgDeviceRepository,
} from '../repositories/device.repository';
import { generateDeviceKey, hashDeviceKey, setupLink } from '../auth/device-key';

export interface DeviceAdminRepositories {
  devices: DeviceRepository;
  auditLog: AuditLogRepository;
}

export function pgDeviceAdminRepositories(db: Database): DeviceAdminRepositories {
  return { devices: new PgDeviceRepository(db), auditLog: new PgAuditLogRepository(db) };
}

/** A device just created, with the key that is shown once. */
export interface IssuedDevice {
  id: string;
  label: string;
  key: string;
  link: string;
}

/** A command refused before anything was written. */
export class DeviceCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceCommandError';
  }
}

/** Longest label accepted; it is printed on the setup sheet. */
const MAX_LABEL = 100;

/**
 * Creates one device per label in one transaction: every label must be new, in the input and in `devices`,
 * otherwise nothing is created. One audit row per device.
 */
export async function addDevices(
  db: Database,
  repos: DeviceAdminRepositories,
  labels: readonly string[],
  host: string,
): Promise<IssuedDevice[]> {
  checkLabels(labels);
  try {
    return await db.transaction(async (tx) => {
      const taken: string[] = [];
      for (const label of labels) {
        if (await repos.devices.findByLabel(label, tx)) taken.push(label);
      }
      if (taken.length > 0) {
        throw new DeviceCommandError(
          `Label already registered, nothing created: ${taken.map(quote).join(', ')}`,
        );
      }
      const issued: IssuedDevice[] = [];
      for (const label of labels) {
        const key = generateDeviceKey();
        const device = await repos.devices.insert(
          { id: randomUUID(), label, keySha256: hashDeviceKey(key) },
          tx,
        );
        await repos.auditLog.append(
          {
            actor: 'script:device:add',
            action: 'add',
            entity: 'devices',
            entityId: device.id,
            details: { label },
          },
          tx,
        );
        issued.push({ id: device.id, label, key, link: setupLink(host, key) });
      }
      return issued;
    });
  } catch (error) {
    // Another `device:add` took a label between the check and the insert.
    if ((error as { code?: string }).code === '23505') {
      throw new DeviceCommandError('Label already registered, nothing created');
    }
    throw error;
  }
}

/** Revokes the device with `label`; its key stops working at once. Revoking twice keeps the first time. */
export async function revokeDevice(
  db: Database,
  repos: DeviceAdminRepositories,
  label: string,
): Promise<{ device: Device; alreadyRevoked: boolean }> {
  return db.transaction(async (tx) => {
    const before = await repos.devices.findByLabel(label, tx);
    if (!before) throw new DeviceCommandError(`No device has the label ${quote(label)}`);
    const device = (await repos.devices.revoke(label, tx))!;
    await repos.auditLog.append(
      {
        actor: 'script:device:revoke',
        action: 'revoke',
        entity: 'devices',
        entityId: device.id,
        details: { label, alreadyRevoked: before.revokedAt !== null },
      },
      tx,
    );
    return { device, alreadyRevoked: before.revokedAt !== null };
  });
}

/** Every device, revoked ones included, by label. */
export async function listDevices(db: Database, repos: DeviceAdminRepositories): Promise<Device[]> {
  return db.transaction(async (tx) => {
    const devices = await repos.devices.list(tx);
    await repos.auditLog.append(
      {
        actor: 'script:device:list',
        action: 'list',
        entity: 'devices',
        details: { count: devices.length },
      },
      tx,
    );
    return devices;
  });
}

function checkLabels(labels: readonly string[]): void {
  if (labels.length === 0) throw new DeviceCommandError('No label given');
  const problems: string[] = [];
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const label of labels) {
    if (label.trim() !== label || label.length === 0) {
      problems.push(`Label ${quote(label)} is empty or has spaces at either end`);
    } else if (label.length > MAX_LABEL) {
      problems.push(`Label ${quote(label)} is longer than ${MAX_LABEL} characters`);
    }
    if (seen.has(label)) repeated.add(label);
    seen.add(label);
  }
  if (repeated.size > 0) {
    problems.push(`Label given more than once: ${[...repeated].map(quote).join(', ')}`);
  }
  if (problems.length > 0) {
    throw new DeviceCommandError(`${problems.join('\n')}\nNothing created.`);
  }
}

function quote(label: string): string {
  return `"${label}"`;
}
