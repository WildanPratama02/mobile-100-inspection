/**
 * Unit tests of `DeviceKeyGuard`'s database failure handling (doc 03 §5.7, doc 02 §10): only an error that means
 * the database cannot be reached flips the `DB` readiness check; any other error from the key lookup passes on
 * (`500 INTERNAL`) and leaves readiness alone. The happy paths and revocation run against PostgreSQL in
 * `auth.db.spec.ts`.
 */
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ApiProblem } from '../errors/problem';
import type { ReadinessService } from '../master-data/readiness.service';
import type { DeviceRepository } from '../repositories/device.repository';
import { generateDeviceKey } from './device-key';
import { DeviceKeyGuard } from './device-key.guard';

function guardFailingWith(error: Error) {
  const reportFailure = jest.fn();
  const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
  const devices = {
    findByKeySha256: () => Promise.reject(error),
    touchLastSeen: () => Promise.resolve(),
  } as unknown as DeviceRepository;
  const readiness = { reportFailure } as unknown as ReadinessService;
  const guard = new DeviceKeyGuard(reflector, devices, readiness);
  const request = { ip: '10.0.0.7', headers: { 'x-device-key': generateDeviceKey() } };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { canActivate: () => guard.canActivate(context), reportFailure };
}

describe('DeviceKeyGuard on a failed key lookup (doc 03 §5.7)', () => {
  it.each([
    [
      'a refused connection',
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    ],
    ['too many clients (53300)', Object.assign(new Error('too many clients'), { code: '53300' })],
    ['a lost connection', new Error('Connection terminated unexpectedly')],
  ])('%s flips DB and answers 503 DB_UNAVAILABLE for an unknown key', async (_label, error) => {
    const { canActivate, reportFailure } = guardFailingWith(error);
    const refusal = await canActivate().catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ApiProblem);
    expect((refusal as ApiProblem).getStatus()).toBe(503);
    expect((refusal as ApiProblem).code).toBe('DB_UNAVAILABLE');
    expect(reportFailure).toHaveBeenCalledWith('DB', error);
  });

  it.each([
    [
      'a failed statement (42P01)',
      Object.assign(new Error('relation does not exist'), { code: '42P01' }),
    ],
    ['a programming error', new TypeError('Cannot read properties of undefined')],
  ])('%s passes on and does not flip DB', async (_label, error) => {
    const { canActivate, reportFailure } = guardFailingWith(error);
    await expect(canActivate()).rejects.toBe(error);
    expect(reportFailure).not.toHaveBeenCalled();
  });
});
