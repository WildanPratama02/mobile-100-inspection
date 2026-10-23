/**
 * Master data kept by the admins row by row (doc 02 §5.2, doc 04 §8, doc 05 §20.4–20.5): PSI users, factories and
 * cells, POs, defects and map rows. Nothing is deleted, only deactivated. Each change is one transaction that also
 * writes its `audit_log` row (old and new values of the changed fields) and bumps `master_version`, so tablets see it
 * at their next `/master-data` refresh (AC-14.1). A change that changes nothing writes nothing. A duplicate natural
 * key is `409 CONFLICT`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AdminPrincipal } from '../../auth/auth.decorator';
import { ApiProblem } from '../../errors/problem';
import { checksFailed, validationFailed } from '../../errors/validation';
import {
  AUDIT_LOG_REPOSITORY,
  type AuditLogRepository,
} from '../../repositories/audit-log.repository';
import {
  ADMIN_TABLE_KEY,
  type AdminAreaMap,
  type AdminCell,
  type AdminChanges,
  type AdminDefect,
  type AdminFactory,
  type AdminInsert,
  type AdminKey,
  type AdminMapRow,
  type AdminPo,
  type AdminPsiUser,
  type AdminRows,
  type AdminTable,
  MASTER_ADMIN_REPOSITORY,
  type MasterAdminRepository,
  type MasterAdminTx,
} from '../../repositories/master-admin.repository';
import { PO_REPOSITORY, type PoRepository } from '../../repositories/po.repository';
import {
  SETTINGS_REPOSITORY,
  type SettingsRepository,
} from '../../repositories/settings.repository';
import { AdminDb } from '../admin-db';
import { isoDate } from '../admin-input';

/** Doc 05 §20.5: up to 50 hits. */
export const ADMIN_PO_SEARCH = { minLength: 3, maxLength: 40, maxResults: 50 } as const;

/** Text an admin types for a name or code: not empty, no spaces at either end, no control characters. */
const label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim() === s, { message: 'Tidak boleh diawali atau diakhiri spasi.' })
    // eslint-disable-next-line no-control-regex
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), { message: 'Berisi karakter kontrol.' });
/** Free text of a PO (article, model, destination): may be empty, kept as typed (doc 02 §3.3). */
const poText = z
  .string()
  .max(200)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), { message: 'Berisi karakter kontrol.' });
const level = z.enum(['PSI lv.1', 'PSI lv.2']);
const id = z.number().int().min(1).max(2_147_483_647);
const poFields = {
  article: poText,
  model: poText,
  destination: poText,
  orderQty: z.number().int().min(1).max(2_147_483_647),
  podd: isoDate.nullable(),
  crd: isoDate.nullable(),
};
const nonEmpty = { message: 'Tidak ada perubahan yang dikirim.' };

// Unknown fields are refused (doc 03 §6).
const schemas = {
  psiUserCreate: z.strictObject({ username: label(100), level, active: z.boolean().optional() }),
  psiUserPatch: z
    .strictObject({ username: label(100), level, active: z.boolean() })
    .partial()
    .refine((b) => Object.keys(b).length > 0, nonEmpty),
  factoryCreate: z.strictObject({ name: label(50) }),
  factoryPatch: z
    .strictObject({ name: label(50), active: z.boolean() })
    .partial()
    .refine((b) => Object.keys(b).length > 0, nonEmpty),
  cellCreate: z.strictObject({ factoryId: id, code: label(50) }),
  cellPatch: z
    .strictObject({ factoryId: id, code: label(50), active: z.boolean() })
    .partial()
    .refine((b) => Object.keys(b).length > 0, nonEmpty),
  poCreate: z.strictObject({ po: label(40), ...poFields }),
  poPatch: z
    .strictObject({ ...poFields, active: z.boolean() })
    .partial()
    .refine((b) => Object.keys(b).length > 0, nonEmpty),
  activePatch: z.strictObject({ active: z.boolean() }),
  poSearch: z.object({
    q: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.string().min(ADMIN_PO_SEARCH.minLength).max(ADMIN_PO_SEARCH.maxLength)),
  }),
  cellsQuery: z.object({ factoryId: z.coerce.number().pipe(id).optional() }),
};

/** `detail` of a `409 CONFLICT`, per table (doc 05 §20.4). */
const CONFLICT_DETAIL: Record<AdminTable, string> = {
  psi_users: 'Nama dan level ini sudah ada.',
  factories: 'Factory ini sudah ada.',
  cells: 'Cell ini sudah ada.',
  pos: 'PO ini sudah ada.',
  defects: 'Defect ini sudah ada.',
  area_map: 'Baris peta ini sudah ada.',
};
const NOT_FOUND_DETAIL = 'Data tidak ditemukan.';

@Injectable()
export class MasterAdminService {
  constructor(
    @Inject(MASTER_ADMIN_REPOSITORY) private readonly repo: MasterAdminRepository,
    @Inject(PO_REPOSITORY) private readonly pos: PoRepository,
    @Inject(SETTINGS_REPOSITORY) private readonly settings: SettingsRepository,
    @Inject(AUDIT_LOG_REPOSITORY) private readonly auditLog: AuditLogRepository,
    @Inject(AdminDb) private readonly db: AdminDb,
  ) {}

  // PSI users (doc 05 §20.4, A2)

  psiUsers(): Promise<AdminPsiUser[]> {
    return this.db.run(() => this.repo.psiUsers());
  }

  createPsiUser(admin: AdminPrincipal, body: unknown): Promise<AdminPsiUser> {
    const input = parse(schemas.psiUserCreate, body);
    return this.create(admin, 'psi_users', { ...input, active: input.active ?? true });
  }

  updatePsiUser(admin: AdminPrincipal, key: string, body: unknown): Promise<AdminPsiUser> {
    return this.update(admin, 'psi_users', intKey(key), parse(schemas.psiUserPatch, body));
  }

  // Factories and cells (A3)

  factories(): Promise<AdminFactory[]> {
    return this.db.run(() => this.repo.factories());
  }

  createFactory(admin: AdminPrincipal, body: unknown): Promise<AdminFactory> {
    return this.create(admin, 'factories', { ...parse(schemas.factoryCreate, body), active: true });
  }

  updateFactory(admin: AdminPrincipal, key: string, body: unknown): Promise<AdminFactory> {
    return this.update(admin, 'factories', intKey(key), parse(schemas.factoryPatch, body));
  }

  cells(query: unknown): Promise<AdminCell[]> {
    const { factoryId } = parse(schemas.cellsQuery, query);
    return this.db.run(() => this.repo.cells(factoryId));
  }

  async createCell(admin: AdminPrincipal, body: unknown): Promise<AdminCell> {
    const input = parse(schemas.cellCreate, body);
    const cell = await this.create(admin, 'cells', { ...input, active: true }, (tx) =>
      requireFactory(tx, input.factoryId),
    );
    return this.withFactory(cell);
  }

  async updateCell(admin: AdminPrincipal, key: string, body: unknown): Promise<AdminCell> {
    const changes = parse(schemas.cellPatch, body);
    const cell = await this.update(admin, 'cells', intKey(key), changes, (tx) =>
      changes.factoryId === undefined ? Promise.resolve() : requireFactory(tx, changes.factoryId),
    );
    return this.withFactory(cell);
  }

  // POs (A4)

  searchPos(query: unknown): Promise<AdminPo[]> {
    const { q } = parse(schemas.poSearch, query);
    return this.db.run(() => this.pos.searchAll(q, ADMIN_PO_SEARCH.maxResults));
  }

  createPo(admin: AdminPrincipal, body: unknown): Promise<AdminPo> {
    const input = parse(schemas.poCreate, body);
    // `finished` stays empty until PRD OQ-06 is decided.
    return this.create(admin, 'pos', { ...input, finished: null, active: true, source: 'admin' });
  }

  updatePo(admin: AdminPrincipal, po: string, body: unknown): Promise<AdminPo> {
    const changes = parse(schemas.poPatch, body);
    return this.update(admin, 'pos', po, changes, undefined, (diff) =>
      // A PO whose values an admin changed is the admin's from now on, as `upsertMany` records it for an import.
      Object.keys(diff).some((k) => k !== 'active') ? { source: 'admin' } : {},
    );
  }

  // Defects and the area map (A5): view, and toggle `active`; names are not editable in release 1.

  defects(): Promise<AdminDefect[]> {
    return this.db.run(() => this.repo.defects());
  }

  updateDefect(admin: AdminPrincipal, key: string, body: unknown): Promise<AdminDefect> {
    return this.update(
      admin,
      'defects',
      key as AdminDefect['id'],
      parse(schemas.activePatch, body),
    );
  }

  areaMap(): Promise<AdminAreaMap> {
    return this.db.run(() => this.repo.areaMap());
  }

  updateMapRow(admin: AdminPrincipal, key: string, body: unknown): Promise<AdminMapRow> {
    return this.update(admin, 'area_map', key, parse(schemas.activePatch, body));
  }

  private async create<T extends AdminTable>(
    admin: AdminPrincipal,
    table: T,
    row: AdminInsert<T>,
    check?: (tx: MasterAdminTx) => Promise<void>,
  ): Promise<AdminRows[T]> {
    return this.write(table, async (tx) => {
      await check?.(tx);
      const created = await tx.insert(table, row);
      const key = (created as unknown as Record<string, unknown>)[ADMIN_TABLE_KEY[table]];
      await this.record(tx, admin, 'create', table, String(key), { new: row });
      return created;
    });
  }

  /**
   * Applies the fields of `changes` that differ from the stored row. `extra` adds bookkeeping columns to a real
   * change; they are not part of the audit diff.
   */
  private async update<T extends AdminTable>(
    admin: AdminPrincipal,
    table: T,
    key: AdminKey<T>,
    changes: AdminChanges<T>,
    check?: (tx: MasterAdminTx) => Promise<void>,
    extra?: (diff: AdminChanges<T>) => AdminChanges<T>,
  ): Promise<AdminRows[T]> {
    return this.write(table, async (tx) => {
      const old = await tx.find(table, key);
      if (!old) throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
      const stored = old as unknown as Record<string, unknown>;
      const diff = Object.fromEntries(
        Object.entries(changes).filter(([field, value]) => stored[field] !== value),
      ) as AdminChanges<T>;
      const fields = Object.keys(diff);
      if (fields.length === 0) return old;
      await check?.(tx);
      const updated = await tx.update(table, key, { ...diff, ...extra?.(diff) });
      const action =
        fields.length === 1 && fields[0] === 'active'
          ? (diff as { active: boolean }).active
            ? 'reactivate'
            : 'deactivate'
          : 'update';
      await this.record(tx, admin, action, table, String(key), {
        old: Object.fromEntries(fields.map((f) => [f, stored[f]])),
        new: diff,
      });
      return updated;
    });
  }

  private async write<T>(table: AdminTable, fn: (tx: MasterAdminTx) => Promise<T>): Promise<T> {
    try {
      return await this.db.run(() => this.repo.transaction(fn));
    } catch (error) {
      if ((error as { code?: unknown }).code === '23505') {
        throw new ApiProblem('CONFLICT', { detail: CONFLICT_DETAIL[table] });
      }
      throw error;
    }
  }

  /** The audit row and the `master_version` bump, in the change's transaction. */
  private async record(
    tx: MasterAdminTx,
    admin: AdminPrincipal,
    action: string,
    entity: AdminTable,
    entityId: string,
    details: unknown,
  ): Promise<void> {
    await this.auditLog.append(
      { actor: `admin:${admin.username}`, action, entity, entityId, details },
      tx.q,
    );
    await this.settings.bumpMasterVersion(tx.q);
  }

  private async withFactory(cell: AdminRows['cells']): Promise<AdminCell> {
    const factories = await this.db.run(() => this.repo.factories());
    return { ...cell, factory: factories.find((f) => f.id === cell.factoryId)!.name };
  }
}

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationFailed(parsed.error, input);
  return parsed.data;
}

/** A numeric id from the path; anything else names no row. */
function intKey(key: string): number {
  const n = /^[1-9][0-9]{0,9}$/.test(key) ? Number(key) : NaN;
  if (!Number.isSafeInteger(n) || n > 2_147_483_647) {
    throw new ApiProblem('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
  }
  return n;
}

async function requireFactory(tx: MasterAdminTx, factoryId: number): Promise<void> {
  if (!(await tx.find('factories', factoryId))) {
    throw checksFailed([
      { path: 'factoryId', code: 'NOT_FOUND', message: 'Factory tidak ditemukan.' },
    ]);
  }
}
