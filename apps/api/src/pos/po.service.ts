import { Inject, Injectable } from '@nestjs/common';
import type { Po } from '@m100/shared';
import { z } from 'zod';
import { ApiProblem } from '../errors/problem';
import { validationFailed } from '../errors/validation';
import { ReadinessService, RETRY_MS } from '../master-data/readiness.service';
import { PO_REPOSITORY, type PoRepository } from '../repositories/po.repository';

/** `q` after trimming, in characters, and the result limit (doc 04 §3.3, §7; `04-openapi.yaml`). */
export const PO_SEARCH = { minLength: 3, maxLength: 40, maxResults: 20 } as const;

const length = (s: string) => [...s].length;

// Unknown parameters are refused (doc 03 §6); a repeated `q` arrives as an array and is refused too.
const searchSchema = z.strictObject({
  q: z
    .string()
    .trim()
    .refine((s) => length(s) >= PO_SEARCH.minLength, {
      message: `At least ${PO_SEARCH.minLength} characters`,
    })
    .refine((s) => length(s) <= PO_SEARCH.maxLength, {
      message: `At most ${PO_SEARCH.maxLength} characters`,
    }),
  limit: z
    .string()
    .regex(/^[0-9]+$/, 'An integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(PO_SEARCH.maxResults))
    .optional(),
});

/** The search response of `GET /pos` in `04-openapi.yaml`. */
export interface PoSearchResponse {
  items: Po[];
}

/** `GET /pos` and `GET /pos/{po}` (doc 04 §3.3). Only active POs; `finished` does not filter (PRD OQ-06). */
@Injectable()
export class PoService {
  constructor(
    @Inject(PO_REPOSITORY) private readonly pos: PoRepository,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}

  /** `q` trimmed, 3–40 characters, `limit` 1–20 (default 20), else `422 VALIDATION_FAILED`. */
  async search(query: unknown): Promise<PoSearchResponse> {
    const parsed = searchSchema.safeParse(query);
    if (!parsed.success) throw validationFailed(parsed.error, query);
    const { q, limit = PO_SEARCH.maxResults } = parsed.data;
    return { items: await this.read(() => this.pos.search(q, limit)) };
  }

  /** The active PO with exactly this number, else `404 PO_NOT_FOUND`. */
  async get(po: string): Promise<Po> {
    const found = await this.read(() => this.pos.findByPo(po));
    if (!found?.active) throw new ApiProblem('PO_NOT_FOUND');
    const { po: number, article, model, destination, orderQty, podd, crd } = found;
    return { po: number, article, model, destination, orderQty, podd, crd };
  }

  /** A database error flips the `DB` check and answers `503 DB_UNAVAILABLE` (doc 03 §5.7). */
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.readiness.reportFailure('DB', error);
      throw new ApiProblem('DB_UNAVAILABLE', { retryAfter: RETRY_MS / 1000 });
    }
  }
}
