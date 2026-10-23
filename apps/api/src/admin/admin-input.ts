/**
 * Reading admin queries and bodies with zod: a refused value becomes `422 VALIDATION_FAILED` (doc 04 §6), and an
 * empty query value (`?factory=`, as an HTML form sends it) means "no filter".
 */
import { z } from 'zod';
import { validationFailed } from '../errors/validation';

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationFailed(parsed.error, input);
  return parsed.data;
}

/**
 * `YYYY-MM-DD` naming a real day. Checked in one function, because zod runs a refinement also after the pattern
 * failed, and `toISOString` of an invalid date throws.
 */
export function isCalendarDate(s: string): boolean {
  const at = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === s;
}

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDate, { message: 'Bukan tanggal.' });

/** An optional query value; an empty one is absent. */
export const optionalQuery = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

/** `page` of a paged list: a whole number from 1, default 1. */
export const pageQuery = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.coerce.number().int().min(1).max(1_000_000).default(1),
);

/** A `from`–`to` range must not end before it starts. */
export const rangeInOrder = <T extends { from?: string; to?: string }>(f: T) =>
  !f.from || !f.to || f.from <= f.to;
export const RANGE_ERROR = { path: ['to'], message: 'Tanggal akhir sebelum tanggal awal.' };
