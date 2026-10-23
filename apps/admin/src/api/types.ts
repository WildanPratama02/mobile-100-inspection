/** The admin schemas of `docs/04-openapi.yaml` (doc 04 §8), as the admin app reads them. */
import type { AreaId, Classification, DefectId, InspectionType, Po, PsiLevel } from '@m100/shared';

export type { Classification, DefectId, PsiLevel };

/** One entry of a problem's `errors` list (409, 422). */
export interface ProblemError {
  path?: string;
  sheet?: string;
  row?: number;
  code: string;
  message: string;
}

/** `application/problem+json` (RFC 9457) of doc 04 §6. */
export interface Problem {
  type?: string;
  title?: string;
  status: number;
  code: string;
  retryable?: boolean;
  detail?: string;
  errors?: ProblemError[];
}

export interface AdminMe {
  username: string;
  lastLoginAt?: string;
}

export interface AdminPsiUser {
  id: number;
  username: string;
  level: PsiLevel;
  active: boolean;
}

export interface AdminFactory {
  id: number;
  name: string;
  active: boolean;
}

export interface AdminCell {
  id: number;
  factoryId: number;
  factory: string;
  code: string;
  active: boolean;
}

export interface AdminPo extends Po {
  /** Not imported or editable until PRD OQ-06 is decided. */
  finished: boolean | null;
  active: boolean;
  source: string;
}

export type AdminPoInput = Partial<Omit<Po, 'po'>> & { active?: boolean };

export interface AdminDefect {
  id: DefectId;
  name: string;
  classification: Classification;
  ctqCategory: string | null;
  ctqCode: string | null;
  active: boolean;
}

export interface AdminMapRow {
  id: string;
  areaId: AreaId;
  subAreaId: string;
  familyId: string;
  defectId: DefectId;
  active: boolean;
}

export interface AdminAreaMap {
  areas: { id: AreaId; name: string; sort: number; active: boolean }[];
  subAreas: { id: string; areaId: AreaId; name: string; sort: number; active: boolean }[];
  families: { id: string; name: string; active: boolean }[];
  rows: AdminMapRow[];
}

export interface ImportReport {
  dryRun: boolean;
  read: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: { sheet: string; row?: number; code: string; message: string }[];
  warnings: string[];
  tables?: Record<string, { inserted: number; updated: number; unchanged: number }>;
}

export interface Page<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

export interface AdminSubmissionSummary {
  id: string;
  displayNo: string;
  sealedAt: string;
  inspectionDate: string;
  username: string;
  level: PsiLevel;
  factory: string;
  cell: string;
  po: string;
  partialText: string | null;
  qtyInspection: number;
  qtyDefect: number;
  qtyAGrade: number;
  qtyBGrade: number;
  rft: number;
  defectRate: number;
  photoCount: number;
}

export interface AdminFinding {
  inspectionType: InspectionType;
  areaId: AreaId;
  areaName: string;
  subAreaId: string;
  subAreaName: string;
  familyId: string;
  familyName: string;
  defectId: DefectId;
  defectName: string;
  classification: Classification;
  qty: number;
  firstRecordedAt: string;
}

export interface AdminSubmissionDetail extends AdminSubmissionSummary {
  receivedAt: string;
  appVersion: string | null;
  article: string;
  model: string;
  destination: string;
  orderQty: number;
  podd: string | null;
  crd: string | null;
  partial: { number: number; qty: number } | null;
  counts: { rework: number; bGrade: number; noDefect: number };
  findings: AdminFinding[];
  top5: {
    rank: number;
    defectId: DefectId;
    defectName: string;
    classification: Classification;
    qty: number;
    photoId: number | null;
  }[];
  photos: { id: number; defectId: DefectId }[];
  audit: { id: string; at: string; actor: string; action: string; details: unknown }[];
}

export interface AdminAccount {
  id: number;
  username: string;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  lockedUntil: string | null;
}

export interface AuditLogEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string | null;
  details: unknown;
}

/** The filters of `GET /admin/submissions` (doc 04 §10 A12); an empty value is no filter. */
export interface SubmissionFilter {
  from: string;
  to: string;
  factory: string;
  cell: string;
  username: string;
  po: string;
}

export interface AuditFilter {
  from: string;
  to: string;
  actor: string;
}
