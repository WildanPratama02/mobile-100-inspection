/**
 * `devices` (doc 02 §5.3, ADR-014): registered tablets, managed by the CLI `device:add` / `device:revoke` /
 * `device:list`. Only the SHA-256 of a device key is stored; the key itself never reaches this code.
 */
import type { Database, Queryable } from '../db/database';

export const DEVICE_REPOSITORY = Symbol('DeviceRepository');

export interface Device {
  id: string;
  label: string;
  /** 32 bytes. */
  keySha256: Buffer;
  createdAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
}

export interface NewDevice {
  id: string;
  label: string;
  keySha256: Buffer;
}

export interface DeviceRepository {
  /** Fails with SQLSTATE `23505` when the label or the key hash is taken. */
  insert(device: NewDevice, q?: Queryable): Promise<Device>;
  /** The device with this key hash, revoked or not; the guard decides. */
  findByKeySha256(keySha256: Buffer, q?: Queryable): Promise<Device | null>;
  findByLabel(label: string, q?: Queryable): Promise<Device | null>;
  /** Every device, revoked ones included, by label. */
  list(q?: Queryable): Promise<Device[]>;
  /** Sets `revoked_at` once (a second revoke keeps the first time); `null` when no device has the label. */
  revoke(label: string, q?: Queryable): Promise<Device | null>;
  touchLastSeen(id: string, q?: Queryable): Promise<void>;
}

const COLUMNS = `id, label, key_sha256 AS "keySha256", created_at AS "createdAt", revoked_at AS "revokedAt",
                 last_seen_at AS "lastSeenAt"`;

export class PgDeviceRepository implements DeviceRepository {
  constructor(private readonly db: Database) {}

  async insert(device: NewDevice, q: Queryable = this.db): Promise<Device> {
    const { rows } = await q.query<Device>(
      `INSERT INTO devices (id, label, key_sha256) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [device.id, device.label, device.keySha256],
    );
    return rows[0]!;
  }

  async findByKeySha256(keySha256: Buffer, q: Queryable = this.db): Promise<Device | null> {
    const { rows } = await q.query<Device>(`SELECT ${COLUMNS} FROM devices WHERE key_sha256 = $1`, [
      keySha256,
    ]);
    return rows[0] ?? null;
  }

  async findByLabel(label: string, q: Queryable = this.db): Promise<Device | null> {
    const { rows } = await q.query<Device>(`SELECT ${COLUMNS} FROM devices WHERE label = $1`, [
      label,
    ]);
    return rows[0] ?? null;
  }

  async list(q: Queryable = this.db): Promise<Device[]> {
    const { rows } = await q.query<Device>(`SELECT ${COLUMNS} FROM devices ORDER BY label`);
    return rows;
  }

  async revoke(label: string, q: Queryable = this.db): Promise<Device | null> {
    const { rows } = await q.query<Device>(
      `UPDATE devices SET revoked_at = coalesce(revoked_at, now()) WHERE label = $1 RETURNING ${COLUMNS}`,
      [label],
    );
    return rows[0] ?? null;
  }

  async touchLastSeen(id: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [id]);
  }
}
