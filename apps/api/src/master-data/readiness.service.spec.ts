import { Logger } from '@nestjs/common';
import { listMigrations } from '../db/migrate';
import type { PhotoStore } from '../photos/photo-store';
import type { MasterDataCounts, ReadinessRepository } from '../repositories/readiness.repository';
import type { SettingsRepository } from '../repositories/settings.repository';
import { testConfig } from '../testing/env';
import { RETRY_MS, ReadinessService } from './readiness.service';

const HEALTHY: MasterDataCounts = {
  activeUsers: 14,
  activeCells: 40,
  defects: 98,
  areas: 12,
  activeMapRows: 437,
  unmappedDefects: 0,
};

let dbUp: boolean;
let runs: number;

function service(): ReadinessService {
  const down = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
  const readiness: ReadinessRepository = {
    latestMigration: () => {
      runs++;
      return dbUp ? Promise.resolve(listMigrations().at(-1)!.version) : down();
    },
    masterDataCounts: () => (dbUp ? Promise.resolve(HEALTHY) : down()),
  };
  const settings = {
    masterVersion: () => (dbUp ? Promise.resolve(3) : down()),
    submitEnabled: () => (dbUp ? Promise.resolve(true) : down()),
  } as unknown as SettingsRepository;
  const photos = { probe: () => Promise.resolve() } as unknown as PhotoStore;
  return new ReadinessService(testConfig(), readiness, settings, photos);
}

/** Lets the checks that a fired timer started run to the end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeAll(() => {
  Logger.overrideLogger(false);
});

beforeEach(() => {
  jest.useFakeTimers();
  dbUp = true;
  runs = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ReadinessService scheduling (doc 02 §10)', () => {
  it('reports "not checked yet" and Submit PO disabled before the first run', () => {
    const readiness = service();
    expect(readiness.current().submitEnabled).toBe(false);
    expect(readiness.current().checks.every((c) => !c.ok)).toBe(true);
  });

  it('runs at start, then every MASTER_CHECK_SECONDS while healthy', async () => {
    const readiness = service();
    readiness.onApplicationBootstrap();
    await settle();
    expect(runs).toBe(1);
    expect(readiness.current()).toMatchObject({ submitEnabled: true, masterDataVersion: '3' });

    jest.advanceTimersByTime(testConfig().masterCheckSeconds * 1000 - 1);
    await settle();
    expect(runs).toBe(1);
    jest.advanceTimersByTime(1);
    await settle();
    expect(runs).toBe(2);
    readiness.onApplicationShutdown();
  });

  it('retries every 30 s while a check fails, and is enabled again by the first run after recovery', async () => {
    dbUp = false;
    const readiness = service();
    readiness.onApplicationBootstrap();
    await settle();
    expect(readiness.current().submitEnabled).toBe(false);
    expect(readiness.current().checks.find((c) => c.id === 'DB')).toEqual({
      id: 'DB',
      ok: false,
      message: 'Database not reachable',
    });

    dbUp = true;
    jest.advanceTimersByTime(RETRY_MS);
    await settle();
    expect(runs).toBe(2);
    expect(readiness.current().submitEnabled).toBe(true);
    readiness.onApplicationShutdown();
  });

  it('reportFailure flips the check at once and brings the next run forward to 30 s', async () => {
    const readiness = service();
    await readiness.check();
    readiness.reportFailure('PHOTO_STORE', new Error('ENOSPC'));
    expect(readiness.current().submitEnabled).toBe(false);
    expect(readiness.nextDelayMs()).toBe(RETRY_MS);
    jest.advanceTimersByTime(RETRY_MS);
    await settle();
    expect(runs).toBe(2);
    expect(readiness.current().submitEnabled).toBe(true);
    readiness.onApplicationShutdown();
  });

  it('shares one run between concurrent callers and schedules nothing after shutdown', async () => {
    const readiness = service();
    const [a, b] = await Promise.all([readiness.check(), readiness.check()]);
    expect(a).toBe(b);
    expect(runs).toBe(1);
    readiness.onApplicationShutdown();
    jest.advanceTimersByTime(RETRY_MS * 100);
    await settle();
    expect(runs).toBe(1);
  });
});
