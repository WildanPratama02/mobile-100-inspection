/**
 * The readiness checks of doc 02 §10 and doc 03 §5.3: `DB`, `MASTER_DATA`, `PHOTO_STORE`, `SUBMIT_ENABLED`. They run
 * at start, every `MASTER_CHECK_SECONDS` (300 s, "every 5 minutes"), and every 30 s while any fails, so a restored
 * database or store re-enables submitting without a restart. A database or store error met elsewhere flips the
 * matching check at once (`reportFailure`). Submit PO is possible only while every check passes.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Config } from '../config/env';
import { listMigrations } from '../db/migrate';
import { PHOTO_STORE, type PhotoStore } from '../photos/photo-store';
import {
  READINESS_REPOSITORY,
  type ReadinessRepository,
} from '../repositories/readiness.repository';
import { SETTINGS_REPOSITORY, type SettingsRepository } from '../repositories/settings.repository';
import { DEFECT_COUNT } from '../import/parse-master';

export type CheckId = 'DB' | 'MASTER_DATA' | 'PHOTO_STORE' | 'SUBMIT_ENABLED';
export const CHECK_IDS: readonly CheckId[] = ['DB', 'MASTER_DATA', 'PHOTO_STORE', 'SUBMIT_ENABLED'];

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  /** Why the check failed, or a warning when it passed. */
  message?: string;
}

/** The `SystemStatus` schema of `04-openapi.yaml`. */
export interface SystemStatus {
  submitEnabled: boolean;
  checkedAt: string;
  masterDataVersion?: string;
  checks: CheckResult[];
}

/** Interval while any check fails (doc 02 §10). */
export const RETRY_MS = 30_000;
/** A check that has not answered by then has failed; a stopped database must not hold the loop. */
const CHECK_TIMEOUT_MS = 5_000;
const AREA_COUNT = 12;

@Injectable()
export class ReadinessService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Readiness');
  private readonly expectedMigration: string | undefined;
  private readonly healthyMs: number;
  private status: SystemStatus = {
    submitEnabled: false,
    checkedAt: new Date().toISOString(),
    checks: CHECK_IDS.map((id) => ({ id, ok: false, message: 'Not checked yet' })),
  };
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<SystemStatus> | undefined;
  private stopped = false;

  constructor(
    @Inject(APP_CONFIG) config: Config,
    @Inject(READINESS_REPOSITORY) private readonly readiness: ReadinessRepository,
    @Inject(SETTINGS_REPOSITORY) private readonly settings: SettingsRepository,
    @Inject(PHOTO_STORE) private readonly photos: PhotoStore,
  ) {
    this.healthyMs = config.masterCheckSeconds * 1000;
    this.expectedMigration = listMigrations().at(-1)?.version;
  }

  onApplicationBootstrap(): void {
    // Not awaited: the API starts even while the database is down, and reports it here.
    void this.check();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  current(): SystemStatus {
    return this.status;
  }

  /** Milliseconds until the next run, from the last result. */
  nextDelayMs(): number {
    return this.status.submitEnabled ? this.healthyMs : RETRY_MS;
  }

  /** Runs every check now and schedules the next run. Concurrent callers share one run. */
  check(): Promise<SystemStatus> {
    this.running ??= this.runChecks().finally(() => {
      this.running = undefined;
      this.schedule();
    });
    return this.running;
  }

  /** A database or photo store error met while serving a request: the check fails at once and is retried soon. */
  reportFailure(id: 'DB' | 'PHOTO_STORE', error: unknown): void {
    const failed = this.failed(
      id,
      id === 'DB' ? 'Database not reachable' : 'Photo store not writable',
      error,
    );
    const checks = this.status.checks.map((c) => (c.id === id ? failed : c));
    this.publish({ ...this.status, checkedAt: new Date().toISOString(), checks });
    this.schedule();
  }

  /** The tablet sees `message`; the error itself, which may name hosts or paths, goes to the log only. */
  private failed(id: CheckId, message: string, error: unknown): CheckResult {
    this.logger.warn(`${id}: ${errorMessage(error)}`);
    return { id, ok: false, message };
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.check(), this.nextDelayMs());
    // The timer alone must not keep a test or a stopping process alive.
    this.timer.unref();
  }

  private async runChecks(): Promise<SystemStatus> {
    const [db, photoStore, submit, version] = await Promise.all([
      this.checkDb(),
      this.checkPhotoStore(),
      this.checkSubmitEnabled(),
      timeout(this.settings.masterVersion()).catch(() => undefined),
    ]);
    // Master data is only worth reading from a database at the expected version.
    const master: CheckResult = db.ok
      ? await this.checkMasterData()
      : { id: 'MASTER_DATA', ok: false, message: 'Database check failed' };
    const checks = [db, master, photoStore, submit];
    this.publish({
      submitEnabled: false,
      checkedAt: new Date().toISOString(),
      ...(version === undefined ? {} : { masterDataVersion: String(version) }),
      checks,
    });
    return this.status;
  }

  private publish(status: SystemStatus): void {
    const submitEnabled = status.checks.every((c) => c.ok);
    const failing = status.checks.filter((c) => !c.ok).map((c) => `${c.id} (${c.message})`);
    if (submitEnabled !== this.status.submitEnabled || failing.length > 0) {
      if (submitEnabled) this.logger.log('All readiness checks pass; Submit PO is enabled');
      else this.logger.warn(`Submit PO is disabled: ${failing.join('; ')}`);
    }
    this.status = { ...status, submitEnabled };
  }

  private async checkDb(): Promise<CheckResult> {
    try {
      const applied = await timeout(this.readiness.latestMigration());
      if (applied !== this.expectedMigration) {
        return {
          id: 'DB',
          ok: false,
          message: `Migrations at ${applied ?? 'none'}, expected ${this.expectedMigration ?? 'none'}`,
        };
      }
      return { id: 'DB', ok: true };
    } catch (error) {
      return this.failed('DB', 'Database not reachable', error);
    }
  }

  private async checkMasterData(): Promise<CheckResult> {
    try {
      const c = await timeout(this.readiness.masterDataCounts());
      const problems = [
        c.activeUsers === 0 && 'no active PSI users',
        c.activeCells === 0 && 'no active cells',
        c.defects !== DEFECT_COUNT && `${c.defects} defects, expected ${DEFECT_COUNT}`,
        c.areas !== AREA_COUNT && `${c.areas} areas, expected ${AREA_COUNT}`,
        c.activeMapRows === 0 && 'no active area map rows',
      ].filter((p): p is string => typeof p === 'string');
      if (problems.length > 0)
        return { id: 'MASTER_DATA', ok: false, message: problems.join('; ') };
      return c.unmappedDefects > 0
        ? {
            id: 'MASTER_DATA',
            ok: true,
            message: `${c.unmappedDefects} active defects have no map row`,
          }
        : { id: 'MASTER_DATA', ok: true };
    } catch (error) {
      return this.failed('MASTER_DATA', 'Master data not readable', error);
    }
  }

  private async checkPhotoStore(): Promise<CheckResult> {
    try {
      await timeout(this.photos.probe());
      return { id: 'PHOTO_STORE', ok: true };
    } catch (error) {
      return this.failed('PHOTO_STORE', 'Photo store not writable', error);
    }
  }

  private async checkSubmitEnabled(): Promise<CheckResult> {
    try {
      return (await timeout(this.settings.submitEnabled()))
        ? { id: 'SUBMIT_ENABLED', ok: true }
        : { id: 'SUBMIT_ENABLED', ok: false, message: 'settings.submit_enabled is false' };
    } catch (error) {
      return this.failed('SUBMIT_ENABLED', 'Setting not readable', error);
    }
  }
}

function timeout<T>(promise: Promise<T>, ms = CHECK_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
