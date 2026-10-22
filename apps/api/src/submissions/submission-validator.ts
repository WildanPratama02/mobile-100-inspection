/**
 * Every check of doc 04 §4.2 on a parsed request, before anything is written. The master lookups run in one
 * read-only transaction at `REPEATABLE READ`, so an admin edit during validation cannot produce a half-valid
 * result (doc 02 §6.1 step 2). All failures come back together (`checksFailed`).
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  computeTotals,
  type DefectId,
  type Finding,
  type SubmissionRequest,
  type Totals,
} from '@m100/shared';
import type { TabletClaims } from '../auth/tablet-token';
import { Database, type Queryable } from '../db/database';
import { checksFailed, type Failure, validationFailed } from '../errors/validation';
import {
  MASTER_DATA_REPOSITORY,
  type MapRowRef,
  type MasterDataRepository,
} from '../repositories/master-data.repository';
import { PO_REPOSITORY, type PoRepository } from '../repositories/po.repository';
import type { SubmissionParts } from './multipart';
import { checkSubmission, type KnownDefect } from './submission-checks';
import { type ParsedSubmission, submissionSchema } from './submission-schema';

export interface ValidPhoto {
  defectId: DefectId;
  bytes: Buffer;
  sha256: string;
  size: number;
}

/** A request that passed every check, ready for the write (doc 02 §6.1 steps 3–5). */
export interface ValidSubmission {
  /** The request with each finding's family taken from its map row. */
  request: SubmissionRequest;
  json: Buffer;
  payloadSha256: string;
  photos: ValidPhoto[];
  /** ADR-008 totals computed by the API (doc 04 §4.1). */
  totals: Totals;
}

interface MasterResult {
  failures: Failure[];
  request: SubmissionRequest;
  orderQty: number | null;
  defects: Map<string, KnownDefect>;
}

@Injectable()
export class SubmissionValidator {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(MASTER_DATA_REPOSITORY) private readonly masterData: MasterDataRepository,
    @Inject(PO_REPOSITORY) private readonly pos: PoRepository,
  ) {}

  /** The checked submission, or `ApiProblem` 422 with every failure. */
  async validate(
    parts: SubmissionParts,
    claims: TabletClaims,
    now = new Date(),
  ): Promise<ValidSubmission> {
    const parsed = submissionSchema.safeParse(parts.body);
    if (!parsed.success) throw validationFailed(parsed.error, parts.body);

    const { failures, request, orderQty, defects } = await this.db.transaction(
      (q) => this.checkMasterData(parsed.data, claims, q),
      { isolation: 'REPEATABLE READ', readOnly: true },
    );
    failures.push(...checkSubmission(request, parts.photos, { orderQty, defects, now }));
    if (failures.length > 0) throw checksFailed(failures);

    return {
      request,
      json: parts.json,
      payloadSha256: parts.payloadSha256,
      photos: request.photos.map(({ defectId, part, sha256 }) => {
        const bytes = parts.photos.get(part) as Buffer;
        return { defectId, bytes, sha256, size: bytes.length };
      }),
      totals: computeTotals(request.counts, request.findings),
    };
  }

  /** Rules 1, 2 and the master part of rule 4. */
  private async checkMasterData(
    input: ParsedSubmission,
    claims: TabletClaims,
    q: Queryable,
  ): Promise<MasterResult> {
    const failures: Failure[] = [];
    const { user, factory, cell, findings } = input;

    // Rule 1: the PSI, factory and cell of the token, and still active.
    if (user.username !== claims.sub || user.level !== claims.lvl) {
      failures.push({
        path: 'user',
        code: 'USER_NOT_FOUND',
        message: 'PSI tidak sama dengan login.',
      });
    } else if (!(await this.masterData.findActiveUser(user.username, user.level, q))) {
      failures.push({
        path: 'user',
        code: 'USER_NOT_FOUND',
        message: 'Nama tidak ada di daftar PSI.',
      });
    }
    if (factory !== claims.fac || cell !== claims.cel) {
      failures.push({
        path: 'cell',
        code: 'CELL_NOT_FOUND',
        message: 'Factory/Cell tidak sama dengan login.',
      });
    } else if (!(await this.masterData.findActiveCell(factory, cell, q))) {
      failures.push({
        path: 'cell',
        code: 'CELL_NOT_FOUND',
        message: 'Factory/Cell tidak ditemukan.',
      });
    }

    // Rule 2.
    const po = await this.pos.findByPo(input.po, q);
    if (!po) {
      failures.push({
        path: 'po',
        code: 'PO_NOT_FOUND',
        message: 'PO tidak ditemukan di master PO.',
      });
    }

    // Rule 4: the defect exists, the sub-area is in the area, and the pair is or was mapped there.
    const unique = (values: string[]) => [...new Set(values)];
    const defectRows = await this.masterData.findDefects(
      unique(findings.map((f) => f.defectId)),
      q,
    );
    const defects = new Map<string, KnownDefect>(
      defectRows.map((d) => [d.id, { name: d.name, classification: d.classification }]),
    );
    const subAreas = new Map(
      (await this.masterData.findSubAreas(unique(findings.map((f) => f.subAreaId)), q)).map((s) => [
        s.id,
        s,
      ]),
    );
    const mapRows = await this.masterData.findMapRows(
      findings.map(({ subAreaId, defectId }) => ({ subAreaId, defectId })),
      q,
    );

    const resolved = findings.map((f, i): Finding => {
      const at = `findings[${i}]`;
      if (!defects.has(f.defectId)) {
        failures.push({
          path: `${at}.defectId`,
          code: 'INVALID',
          message: 'Defect tidak ada di master defect.',
        });
      }
      const subArea = subAreas.get(f.subAreaId);
      if (subArea?.areaId !== f.areaId) {
        failures.push({
          path: `${at}.subAreaId`,
          code: 'INVALID',
          message: 'Sub-area bukan bagian dari area ini.',
        });
      }
      const row = mapRowOf(mapRows, f);
      if (defects.has(f.defectId) && subArea?.areaId === f.areaId && !row) {
        failures.push({
          path: at,
          code: 'INVALID',
          message: 'Defect tidak pernah dipetakan ke sub-area ini.',
        });
      }
      return {
        inspectionType: f.inspectionType,
        areaId: f.areaId,
        subAreaId: f.subAreaId,
        familyId: row?.familyId ?? f.familyId ?? '',
        defectId: f.defectId,
        qty: f.qty,
        firstRecordedAt: f.firstRecordedAt,
      };
    });

    return {
      failures,
      request: { ...input, findings: resolved },
      orderQty: po?.orderQty ?? null,
      defects,
    };
  }
}

/** The finding's map row, active or not (a deactivated row is still accepted); an active one first. */
function mapRowOf(
  rows: readonly MapRowRef[],
  f: ParsedSubmission['findings'][number],
): MapRowRef | undefined {
  const matching = rows.filter(
    (r) => r.areaId === f.areaId && r.subAreaId === f.subAreaId && r.defectId === f.defectId,
  );
  return matching.find((r) => r.active) ?? matching[0];
}
