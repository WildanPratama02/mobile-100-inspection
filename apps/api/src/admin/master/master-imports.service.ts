/**
 * The admin imports (doc 04 §8, doc 05 §20.5): a CSV/XLSX of POs, and the mapping workbook again. Both upsert by
 * natural key and never delete, in one transaction with one `audit_log` row, and bump `master_version` only when a
 * row was inserted or changed. A dry run does the same writes and rolls them back, so its counts are what applying
 * would do. Any invalid row applies nothing (AC-14.3): the dry run reports every one, applying answers
 * `422 IMPORT_INVALID` with the same list.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { AdminPrincipal } from '../../auth/auth.decorator';
import { Database, type Queryable } from '../../db/database';
import { ApiProblem, type ProblemError } from '../../errors/problem';
import { type ImportProblem, parseMapping } from '../../import/parse-master';
import { PO_IMPORT_COLUMNS, PO_IMPORT_SHEET, parsePoImport } from '../../import/parse-po-import';
import { mappingFromBuffer, SourceError, tableFromUpload } from '../../import/sources';
import {
  AUDIT_LOG_REPOSITORY,
  type AuditLogRepository,
} from '../../repositories/audit-log.repository';
import {
  MASTER_ADMIN_REPOSITORY,
  type MasterAdminRepository,
} from '../../repositories/master-admin.repository';
import {
  MASTER_DATA_REPOSITORY,
  type MasterDataRepository,
} from '../../repositories/master-data.repository';
import { PO_REPOSITORY, type PoRepository } from '../../repositories/po.repository';
import {
  SETTINGS_REPOSITORY,
  type SettingsRepository,
} from '../../repositories/settings.repository';
import type { UpsertCounts } from '../../repositories/upsert';
import { AdminDb } from '../admin-db';
import type { Upload } from '../upload';

export interface ImportRowError {
  sheet: string;
  /** Row in the sheet (1 is the header); absent for a problem of the whole sheet or file. */
  row?: number;
  code: string;
  message: string;
}

/** The `ImportReport` schema of `04-openapi.yaml`. */
export interface ImportReport {
  dryRun: boolean;
  read: number;
  inserted: number;
  updated: number;
  /** Rows that change nothing: unchanged in the database, or the same as an earlier row of the file. */
  skipped: number;
  errors: ImportRowError[];
  /** Things that are not wrong but worth a look (decision A10 of doc 04 §10). */
  warnings: string[];
  /** Counts per table, for the mapping workbook. */
  tables?: Record<string, UpsertCounts>;
}

/** Thrown inside the transaction to roll a dry run back; never leaves this module. */
class DryRunRollback<T> extends Error {
  constructor(readonly result: T) {
    super('dry run');
  }
}

type MappingTable = 'areas' | 'sub_areas' | 'families' | 'area_map';

@Injectable()
export class MasterImportsService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(MASTER_DATA_REPOSITORY) private readonly masterData: MasterDataRepository,
    @Inject(MASTER_ADMIN_REPOSITORY) private readonly masterAdmin: MasterAdminRepository,
    @Inject(PO_REPOSITORY) private readonly pos: PoRepository,
    @Inject(SETTINGS_REPOSITORY) private readonly settings: SettingsRepository,
    @Inject(AUDIT_LOG_REPOSITORY) private readonly auditLog: AuditLogRepository,
    @Inject(AdminDb) private readonly db: AdminDb,
  ) {}

  /** `POST /admin/pos/import` (decision A9 of doc 04 §10). */
  async importPos(admin: AdminPrincipal, upload: Upload, dryRun: boolean): Promise<ImportReport> {
    const table = await readFile(() =>
      tableFromUpload(upload.bytes, upload.name, PO_IMPORT_SHEET, PO_IMPORT_COLUMNS),
    );
    const parsed = parsePoImport(table);
    const errors = parsed.errors.map(({ line, code, message }) => ({
      sheet: table.sheet,
      row: line,
      code,
      message,
    }));
    if (errors.length > 0 && !dryRun) throw importInvalid(errors);
    const source = `import:${upload.name}`;
    // With errors only a dry run gets here: the valid rows are counted, nothing is kept.
    const counts = await this.write(
      dryRun || errors.length > 0,
      admin,
      'pos',
      async (tx) => {
        const counts = await this.pos.upsertMany(parsed.rows, source, tx);
        return { counts, changed: counts.inserted + counts.updated > 0 };
      },
      (counts) => ({
        file: upload.name,
        read: parsed.read,
        duplicatesMerged: parsed.duplicatesMerged,
        ...counts,
      }),
    );
    return {
      dryRun,
      read: parsed.read,
      inserted: counts.inserted,
      updated: counts.updated,
      skipped: counts.unchanged + parsed.duplicatesMerged,
      errors,
      warnings: [],
    };
  }

  /** `POST /admin/area-map/import`: the same validation as doc 02 §5.1, against the stored defects. */
  async importAreaMap(
    admin: AdminPrincipal,
    upload: Upload,
    dryRun: boolean,
  ): Promise<ImportReport> {
    const tables = await readFile(() => mappingFromBuffer(upload.bytes, upload.name));
    const stored = await this.db.run(async () => ({
      defects: await this.masterAdmin.defects(),
      map: await this.masterAdmin.areaMap(),
    }));
    const problems: ImportProblem[] = [];
    const mapping = parseMapping(
      tables,
      stored.defects,
      (table, message, line) =>
        problems.push({ sheet: table.sheet, ...(line === undefined ? {} : { line }), message }),
      'defects',
    );
    const errors = problems.map(({ sheet, line, message }) => ({
      sheet,
      ...(line === undefined ? {} : { row: line }),
      code: 'MAPPING_INVALID',
      message,
    }));
    const read = mapping.report.mapRows;
    if (errors.length > 0) {
      // Rows that point nowhere cannot even be tried, so a dry run reports the errors without counts.
      if (!dryRun) throw importInvalid(errors);
      return { dryRun, read, inserted: 0, updated: 0, skipped: 0, errors, warnings: [] };
    }

    const warnings = mappingWarnings(stored, mapping);
    const tableCounts = await this.write(
      dryRun,
      admin,
      'area_map',
      async (tx) => {
        // Parents before children: a map row needs its area, sub-area and family.
        const counts: Record<MappingTable, UpsertCounts> = {
          areas: await this.masterData.upsertAreas(mapping.areas, tx),
          sub_areas: await this.masterData.upsertSubAreas(mapping.subAreas, tx),
          families: await this.masterData.upsertFamilies(mapping.families, tx),
          area_map: await this.masterData.upsertAreaMap(mapping.areaMap, tx),
        };
        const changed = Object.values(counts).some((c) => c.inserted + c.updated > 0);
        return { counts, changed };
      },
      (tables) => ({ file: upload.name, tables }),
    );
    const sum = (field: keyof UpsertCounts) =>
      Object.values(tableCounts).reduce((n, c) => n + c[field], 0);
    return {
      dryRun,
      read,
      inserted: sum('inserted'),
      updated: sum('updated'),
      skipped: sum('unchanged'),
      errors: [],
      warnings,
      tables: tableCounts,
    };
  }

  /**
   * Runs `upsert` in one transaction; rolled back when `rollback`, else committed with one audit row (`details` from
   * the counts) and, when something changed, a `master_version` bump. A constraint the rows break (a map row that
   * repeats another row's sub-area, family and defect under a new id, say) is `IMPORT_INVALID`.
   */
  private async write<C>(
    rollback: boolean,
    admin: AdminPrincipal,
    entity: 'pos' | 'area_map',
    upsert: (tx: Queryable) => Promise<{ counts: C; changed: boolean }>,
    details: (counts: C) => Record<string, unknown>,
  ): Promise<C> {
    try {
      return await this.db.run(() =>
        this.database.transaction(async (tx) => {
          const { counts, changed } = await upsert(tx);
          if (rollback) throw new DryRunRollback(counts);
          const masterVersion = changed
            ? await this.settings.bumpMasterVersion(tx)
            : await this.settings.masterVersion(tx);
          await this.auditLog.append(
            {
              actor: `admin:${admin.username}`,
              action: 'import',
              entity,
              details: { ...details(counts), masterVersion },
            },
            tx,
          );
          return counts;
        }),
      );
    } catch (error) {
      if (error instanceof DryRunRollback) return error.result as C;
      const { code, detail } = error as { code?: unknown; detail?: unknown };
      if (code === '23505' || code === '23503') {
        throw importInvalid([
          {
            sheet: entity,
            code: 'CONSTRAINT',
            message: typeof detail === 'string' ? detail : String((error as Error).message),
          },
        ]);
      }
      throw error;
    }
  }
}

async function readFile<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    throw importInvalid([{ sheet: 'file', code: 'FILE_INVALID', message: error.message }]);
  }
}

function importInvalid(errors: readonly ImportRowError[]): ApiProblem {
  const problemErrors: ProblemError[] = errors.map((e) => ({
    path: e.row === undefined ? e.sheet : `${e.sheet} baris ${e.row}`,
    code: e.code,
    message: e.message,
  }));
  return new ApiProblem('IMPORT_INVALID', {
    detail: `Impor ditolak: ${errors.length} masalah. Tidak ada data yang diubah.`,
    errors: problemErrors,
  });
}

/**
 * Stored rows the workbook does not list (left as they are, A10), and active defects that no active map row will
 * offer after the import (a warning, doc 02 §3.5).
 */
function mappingWarnings(
  stored: {
    defects: readonly { id: string; active: boolean }[];
    map: Awaited<ReturnType<MasterAdminRepository['areaMap']>>;
  },
  mapping: ReturnType<typeof parseMapping>,
): string[] {
  const warnings: string[] = [];
  const missing = (what: string, storedIds: readonly string[], ids: readonly string[]) => {
    const listed = new Set(ids);
    const absent = storedIds.filter((id) => !listed.has(id));
    if (absent.length > 0) {
      warnings.push(
        `${what}: ${absent.length} baris ada di database tetapi tidak di workbook (${absent.join(', ')}); tidak diubah.`,
      );
    }
  };
  missing(
    'Area_Master',
    stored.map.areas.map((a) => a.id),
    mapping.areas.map((a) => a.id),
  );
  missing(
    'SubArea_Master',
    stored.map.subAreas.map((s) => s.id),
    mapping.subAreas.map((s) => s.id),
  );
  missing(
    'Defect_Family',
    stored.map.families.map((f) => f.id),
    mapping.families.map((f) => f.id),
  );
  missing(
    'Defect_Area_Map',
    stored.map.rows.map((r) => r.id),
    mapping.areaMap.map((m) => m.mapId),
  );
  // The map after the import: the workbook's rows (a stored row keeps its `active`) and the stored rows it leaves out.
  const storedRows = new Map(stored.map.rows.map((r) => [r.id, r]));
  const listed = new Set(mapping.areaMap.map((m) => m.mapId));
  const offered = new Set([
    ...mapping.areaMap
      .filter((m) => storedRows.get(m.mapId)?.active !== false)
      .map((m) => m.defectId as string),
    ...stored.map.rows
      .filter((r) => r.active && !listed.has(r.id))
      .map((r) => r.defectId as string),
  ]);
  const unmapped = stored.defects.filter((d) => d.active && !offered.has(d.id)).map((d) => d.id);
  if (unmapped.length > 0) {
    warnings.push(`Tidak ada baris peta untuk defect aktif ${unmapped.join(', ')}.`);
  }
  return warnings;
}
