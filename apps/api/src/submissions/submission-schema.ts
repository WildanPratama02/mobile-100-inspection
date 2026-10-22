/**
 * The `submission` part of `POST /submissions` (doc 04 §4.1, `SubmissionRequest` in `04-openapi.yaml`). The
 * tablet sends what happened, not totals: an unknown field, `totals` included, is refused (doc 03 §6).
 */
import type { AreaId, DefectId } from '@m100/shared';
import { z } from 'zod';

/** Findings per submission (doc 04 §7). */
export const MAX_FINDINGS = 2000;

/** ISO 8601 with an offset; fractional seconds are accepted (doc 03 §4.6). */
const moment = z.iso.datetime({ offset: true });
const defectId = z
  .string()
  .regex(/^D\d{3}$/)
  .transform((id) => id as DefectId);
const areaId = z
  .string()
  .regex(/^A\d{2}$/)
  .transform((id) => id as AreaId);
const count = z.int().min(0);

const finding = z.strictObject({
  inspectionType: z.enum(['REWORK', 'B-GRADE']),
  areaId,
  subAreaId: z.string().min(1),
  // Optional in the contract; the API takes the family from the map row.
  familyId: z.string().min(1).optional(),
  defectId,
  qty: z.int().min(1),
  firstRecordedAt: moment,
});

export const submissionSchema = z.strictObject({
  submissionUuid: z.uuidv4(),
  sealedAt: moment,
  appVersion: z.string().min(1),
  user: z.strictObject({
    username: z.string().min(1),
    level: z.enum(['PSI lv.1', 'PSI lv.2']),
  }),
  factory: z.string().min(1),
  cell: z.string().min(1),
  po: z.string().min(1),
  partial: z
    .strictObject({ number: z.int().min(1).max(99), qty: z.int().min(1) })
    .nullable()
    .default(null),
  counts: z.strictObject({ rework: count, bGrade: count, noDefect: count }),
  findings: z.array(finding).max(MAX_FINDINGS),
  photos: z
    .array(
      z.strictObject({
        defectId,
        part: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .default([]),
});

export type ParsedSubmission = z.output<typeof submissionSchema>;
export type ParsedFinding = ParsedSubmission['findings'][number];
