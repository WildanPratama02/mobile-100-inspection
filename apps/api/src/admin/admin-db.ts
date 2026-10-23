import { Inject, Injectable } from '@nestjs/common';
import { isDbUnavailable } from '../db/database';
import { ApiProblem } from '../errors/problem';
import { ReadinessService, RETRY_MS } from '../master-data/readiness.service';

/**
 * Database work of the admin API: a database that cannot be reached flips the `DB` check and answers
 * `503 DB_UNAVAILABLE` (doc 03 §5.7); any other error passes on unchanged.
 */
@Injectable()
export class AdminDb {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ApiProblem || !isDbUnavailable(error)) throw error;
      this.readiness.reportFailure('DB', error);
      throw new ApiProblem('DB_UNAVAILABLE', { retryAfter: RETRY_MS / 1000 });
    }
  }
}
