/**
 * Turns a refused zod parse of a body or query into `422 VALIDATION_FAILED` with one `errors` entry per issue
 * (doc 04 §4.2, §6).
 */
import type { z } from 'zod';
import { ApiProblem, type ProblemError } from './problem';

export function validationFailed(error: z.ZodError, input: unknown): ApiProblem {
  const errors = error.issues.map((issue) => toProblemError(issue, input));
  return new ApiProblem('VALIDATION_FAILED', {
    detail: `Data tidak lengkap: ${errors.map((e) => e.path || e.code).join(', ')}`,
    errors,
  });
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
    path: issue.path.join('.'),
    code: missing ? 'REQUIRED' : 'INVALID',
    message: issue.message,
  };
}
