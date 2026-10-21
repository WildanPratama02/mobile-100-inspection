import { Inject, Injectable } from '@nestjs/common';
import { type PsiLevel, toWibIso } from '@m100/shared';
import { z } from 'zod';
import { ApiProblem } from '../errors/problem';
import { validationFailed } from '../errors/validation';
import { ReadinessService, RETRY_MS } from '../master-data/readiness.service';
import type { Device } from '../repositories/device.repository';
import {
  MASTER_DATA_REPOSITORY,
  type MasterDataRepository,
} from '../repositories/master-data.repository';
import { REFRESH_GRACE_SECONDS, type TabletClaims, TabletTokens } from './tablet-token';

/** The `LoginResponse` schema of `04-openapi.yaml`. */
export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: { username: string; level: PsiLevel };
  factory: string;
  cell: string;
}

// Unknown fields are refused (doc 03 §6).
const loginSchema = z.strictObject({
  username: z.string().min(1),
  level: z.enum(['PSI lv.1', 'PSI lv.2']),
  factory: z.string().min(1),
  cell: z.string().min(1),
});

/** `POST /auth/login` and `POST /auth/refresh` (doc 04 §2, §3.1). */
@Injectable()
export class AuthService {
  constructor(
    @Inject(MASTER_DATA_REPOSITORY) private readonly masterData: MasterDataRepository,
    @Inject(TabletTokens) private readonly tokens: TabletTokens,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}

  /**
   * An active (`username`, `level`) in `psi_users` and an active (`factory`, `cell`), else `422 USER_NOT_FOUND` or
   * `CELL_NOT_FOUND` (user first). The token carries the stored spelling of each value.
   */
  async login(body: unknown, device: Device): Promise<LoginResponse> {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw validationFailed(parsed.error, body);
    const { username, level, factory, cell } = parsed.data;
    const [user, found] = await this.read(async () => [
      await this.masterData.findActiveUser(username, level),
      await this.masterData.findActiveCell(factory, cell),
    ]);
    if (!user) throw new ApiProblem('USER_NOT_FOUND');
    if (!found) throw new ApiProblem('CELL_NOT_FOUND');
    return this.respond({
      sub: user.username,
      lvl: user.level,
      fac: found.factory,
      cel: found.cell,
      dev: device.id,
    });
  }

  /**
   * A new 30-day token with the same claims, for a token of this device that is valid or expired less than 30 days
   * ago (decided 21 Oct 2026, doc 04 §10 A7). The master data is not checked again; a submission is (doc 04 §4.2).
   */
  refresh(token: string | null, device: Device): LoginResponse {
    if (!token) throw new ApiProblem('TOKEN_INVALID');
    const result = this.tokens.verify(token, { graceSeconds: REFRESH_GRACE_SECONDS });
    if (!result.ok || result.claims.dev !== device.id) throw new ApiProblem('TOKEN_INVALID');
    return this.respond(result.claims);
  }

  private respond(claims: TabletClaims): LoginResponse {
    const { token, expiresAt } = this.tokens.issue(claims);
    return {
      token,
      expiresAt: toWibIso(expiresAt),
      user: { username: claims.sub, level: claims.lvl },
      factory: claims.fac,
      cell: claims.cel,
    };
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
