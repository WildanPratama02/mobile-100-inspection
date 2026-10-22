/**
 * Turns a refused zod parse of a body or query into `422 VALIDATION_FAILED` with one `errors` entry per issue
 * (doc 04 §4.2, §6).
 */
import type { z } from 'zod';
import { ApiProblem, PROBLEMS, type ProblemCode, type ProblemError } from './problem';

export function validationFailed(error: z.ZodError, input: unknown): ApiProblem {
  const errors = error.issues.map((issue) => toProblemError(issue, input));
  return new ApiProblem('VALIDATION_FAILED', {
    detail: `Data tidak lengkap: ${errors.map((e) => e.path || e.code).join(', ')}`,
    errors,
  });
}

/** One failed check. `label` names the defect of a `PHOTO_MISSING` for `detail` (`D035 <name>`); it is not sent. */
export interface Failure extends ProblemError {
  label?: string;
}

/** Codes of doc 04 §4.2 that can stand for the whole answer instead of `VALIDATION_FAILED`. */
const SPECIFIC = [
  'USER_NOT_FOUND',
  'CELL_NOT_FOUND',
  'PO_NOT_FOUND',
  'PHOTO_MISSING',
  'PHOTO_NOT_ALLOWED',
] as const satisfies readonly ProblemCode[];
type SpecificCode = (typeof SPECIFIC)[number];

/**
 * Every failed check of a submission in one answer (doc 04 §4.2). `errors` lists them all, each with its own
 * code; the answer carries that code when every failure has the same specific one (only photos missing →
 * `PHOTO_MISSING`), otherwise `VALIDATION_FAILED`. All are `422`, also `PO_NOT_FOUND` (doc 04 §6).
 */
export function checksFailed(failures: readonly Failure[]): ApiProblem {
  const errors = failures.map(({ path, code, message }) => ({ path, code, message }));
  const [first] = failures;
  const code = SPECIFIC.find((c) => c === first?.code && failures.every((f) => f.code === c));
  if (code)
    return new ApiProblem(code, { status: 422, detail: specificDetail(code, failures), errors });
  return new ApiProblem('VALIDATION_FAILED', {
    detail: `Data tidak lengkap: ${[...new Set(errors.map((e) => e.path || e.code))].join(', ')}`,
    errors,
  });
}

function specificDetail(code: SpecificCode, failures: readonly Failure[]): string | undefined {
  if (code === 'PHOTO_MISSING') {
    return `Foto wajib untuk: ${failures.map((f) => f.label ?? f.path).join(', ')}`;
  }
  return PROBLEMS[code].detail;
}

/** `['findings', 2, 'qty']` → `findings[2].qty`, the form of the `Problem` example in `04-openapi.yaml`. */
function issuePath(path: readonly PropertyKey[]): string {
  return path
    .map((part, i) =>
      typeof part === 'number' ? `[${part}]` : `${i === 0 ? '' : '.'}${String(part)}`,
    )
    .join('');
}

function toProblemError(issue: z.core.$ZodIssue, input: unknown): ProblemError {
  if (issue.code === 'unrecognized_keys') {
    return { path: issue.keys.join(', '), code: 'UNKNOWN_FIELD', message: issue.message };
  }
  const field = issue.path[0];
  const missing =
    typeof field === 'string' &&
    input !== null &&
    typeof input === 'object' &&
    (input as Record<string, unknown>)[field] === undefined;
  return {
    path: issuePath(issue.path),
    code: missing ? 'REQUIRED' : 'INVALID',
    message: issue.message,
  };
}
