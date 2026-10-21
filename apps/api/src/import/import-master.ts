/**
 * Writes parsed master data (doc 02 §5.1): one transaction, upserts by natural key, never a delete, one `audit_log`
 * row, and `master_version` bumped when anything changed, so a second identical run changes no data. A dry run
 * does the same writes and rolls them back, so its counts are exactly what a real run would do.
 */
import type { Database, Queryable } from '../db/database';
import {
  type AuditLogRepository,
  PgAuditLogRepository,
} from '../repositories/audit-log.repository';
import {
  type MasterDataRepository,
  PgMasterDataRepository,
} from '../repositories/master-data.repository';
import { PgPoRepository, type PoRepository } from '../repositories/po.repository';
import { PgSettingsRepository, type SettingsRepository } from '../repositories/settings.repository';
import type { UpsertCounts } from '../repositories/upsert';
import type { ParsedMaster, SourceReport } from './parse-master';

export const IMPORT_ACTOR = 'script:import-master';

export interface ImportRepositories {
  masterData: MasterDataRepository;
  pos: PoRepository;
  settings: SettingsRepository;
  auditLog: AuditLogRepository;
}

export function pgImportRepositories(db: Database): ImportRepositories {
  return {
    masterData: new PgMasterDataRepository(db),
    pos: new PgPoRepository(db),
    settings: new PgSettingsRepository(db),
    auditLog: new PgAuditLogRepository(db),
  };
}

export type TableCounts = Record<
  | 'psi_users'
  | 'factories'
  | 'cells'
  | 'defects'
  | 'areas'
  | 'sub_areas'
  | 'families'
  | 'area_map'
  | 'pos',
  UpsertCounts
>;

export interface ImportResult {
  dryRun: boolean;
  /** What the upserts did (or, in a dry run, would do). */
  tables: TableCounts;
  changed: boolean;
  /** `master_version` after the import; unchanged when nothing changed or in a dry run. */
  masterVersion: number;
}

/** Thrown inside the transaction to roll a dry run back; never leaves this module. */
class DryRunRollback extends Error {
  constructor(readonly result: ImportResult) {
    super('dry run');
  }
}

export async function importMaster(
  db: Database,
  repos: ImportRepositories,
  parsed: ParsedMaster,
  { dryRun }: { dryRun: boolean },
): Promise<ImportResult> {
  try {
    return await db.transaction(async (tx) => {
      const versionBefore = await repos.settings.masterVersion(tx);
      const tables = await upsertAll(tx, repos, parsed);
      const changed = Object.values(tables).some((c) => c.inserted + c.updated > 0);
      if (dryRun)
        throw new DryRunRollback({ dryRun, tables, changed, masterVersion: versionBefore });
      const masterVersion = changed ? await repos.settings.bumpMasterVersion(tx) : versionBefore;
      const result: ImportResult = { dryRun, tables, changed, masterVersion };
      await repos.auditLog.append(
        {
          actor: IMPORT_ACTOR,
          action: 'import',
          entity: 'master_data',
          details: {
            tables,
            masterVersion,
            poSource: parsed.poSource,
            source: summary(parsed.report),
          },
        },
        tx,
      );
      return result;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.result;
    throw error;
  }
}

async function upsertAll(
  tx: Queryable,
  { masterData, pos }: ImportRepositories,
  parsed: ParsedMaster,
): Promise<TableCounts> {
  // Parents before children: cells need their factory, map rows their area, sub-area, family and defect.
  return {
    psi_users: await masterData.upsertUsers(parsed.users, tx),
    factories: await masterData.upsertFactories(parsed.factories, tx),
    cells: await masterData.upsertCells(parsed.cells, tx),
    defects: await masterData.upsertDefects(parsed.defects, tx),
    areas: await masterData.upsertAreas(parsed.areas, tx),
    sub_areas: await masterData.upsertSubAreas(parsed.subAreas, tx),
    families: await masterData.upsertFamilies(parsed.families, tx),
    area_map: await masterData.upsertAreaMap(parsed.areaMap, tx),
    pos: await pos.upsertMany(parsed.pos, parsed.poSource, tx),
  };
}

/** The report without row lists or names, for the audit row. */
export function summary(report: SourceReport): unknown {
  const { conflicts, skipped, ...pos } = report.pos;
  return {
    users: report.users,
    cells: report.cells,
    defects: report.defects,
    mapping: { ...report.mapping, unmappedDefects: report.mapping.unmappedDefects.length },
    pos: { ...pos, conflictPos: conflicts.map((c) => c.po), skippedLines: skipped.length },
  };
}
