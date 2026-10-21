import { Writable } from 'node:stream';
import { Body, Controller, Get, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from './app';
import { Auth } from './auth/auth.decorator';
import { AppModule } from './app.module';
import { RATE_LIMIT } from './throttle/device-throttler.guard';
import { testConfig } from './testing/env';
import { expectMatchesSpec, expectProblem } from './testing/openapi';

/** Routes that exist only in this test, to reach the error paths. */
@Controller('test')
@Auth('none')
class ProbeController {
  @Get('boom')
  boom(): never {
    throw new Error('stack-must-not-leak');
  }

  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

class LogCapture extends Writable {
  readonly lines: string[] = [];
  override _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    done();
  }
  get text(): string {
    return this.lines.join('\n');
  }
}

let app: NestExpressApplication;
// One destination for the whole file: nestjs-pino keeps its root logger in a static field, so the first app's
// stream would otherwise keep receiving the out-of-request logs of later apps.
const logs = new LogCapture();

beforeEach(async () => {
  logs.lines.length = 0;
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forConfig(testConfig({ logLevel: 'info' }), { logDestination: logs })],
    controllers: [ProbeController],
  }).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true }));
  await app.init();
});

afterEach(async () => {
  await app.close();
});

const http = () => request(app.getHttpServer());

describe('GET /v1/health', () => {
  it('answers ok as the spec says, with a request id', async () => {
    const res = await http().get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expectMatchesSpec(res, 'get', '/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives every request its own id and logs it', async () => {
    const a = await http().get('/v1/health');
    const b = await http().get('/v1/health');
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    expect(logs.text).toContain(a.headers['x-request-id']);
  });
});

describe('errors are problem+json (doc 04 §6)', () => {
  it.each(['/v1/nope', '/nope', '/v1/health/extra'])(
    'an unknown route %s is a NOT_FOUND problem',
    async (path) => {
      const res = await http().get(path).set('Accept', 'text/html');
      expectProblem(res, 404, 'NOT_FOUND');
      expect(res.text).not.toMatch(/<html|<pre/i);
      expect(res.body).toMatchObject({ retryable: false, type: 'https://m100/errors/not-found' });
      expect(res.headers['x-request-id']).toBeDefined();
    },
  );

  it('turns an unexpected error into INTERNAL without the stack', async () => {
    const res = await http().get('/v1/test/boom');
    const problem = expectProblem(res, 500, 'INTERNAL');
    expect(problem.detail).toBe('Terjadi kesalahan server. Data tetap tersimpan di tablet.');
    expect(problem.retryable).toBe(true);
    expect(res.text).not.toContain('stack-must-not-leak');
    expect(logs.text).toContain('stack-must-not-leak');
    expect(logs.text).toContain(res.headers['x-request-id']);
  });

  it('refuses a body that is not JSON with VALIDATION_FAILED', async () => {
    const res = await http()
      .post('/v1/test/echo')
      .set('Content-Type', 'application/json')
      .send('{"po": ');
    const problem = expectProblem(res, 422, 'VALIDATION_FAILED');
    expect(problem.detail).toBe('Data tidak lengkap: request tidak dapat dibaca.');
    expect(problem.errors).toHaveLength(1);
    expect(problem.errors?.[0]).toMatchObject({ path: '', code: 'MALFORMED_REQUEST' });
  });

  it('accepts a body up to 8 MB and refuses a larger one with PAYLOAD_TOO_LARGE', async () => {
    const ok = await http()
      .post('/v1/test/echo')
      .send({ pad: 'x'.repeat(7 * 1024 * 1024) });
    expect(ok.status).toBe(201);
    const res = await http()
      .post('/v1/test/echo')
      .send({ pad: 'x'.repeat(9 * 1024 * 1024) });
    expectProblem(res, 413, 'PAYLOAD_TOO_LARGE');
  });
});

describe('rate limit: 60 requests per minute per device (doc 04 §7)', () => {
  it('answers the 61st request with RATE_LIMITED and Retry-After; another device is not affected', async () => {
    for (let i = 0; i < RATE_LIMIT.limit; i++) {
      const res = await http().get('/v1/health').set('X-Device-Key', 'tablet-a');
      expect(res.status).toBe(200);
    }
    const blocked = await http().get('/v1/health').set('X-Device-Key', 'tablet-a');
    expect(expectProblem(blocked, 429, 'RATE_LIMITED').retryable).toBe(true);
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    const other = await http().get('/v1/health').set('X-Device-Key', 'tablet-b');
    expect(other.status).toBe(200);
  });

  it('counts one budget across all routes', async () => {
    for (let i = 0; i < RATE_LIMIT.limit; i++) {
      await http()
        .get(i % 2 ? '/v1/health' : '/v1/test/boom')
        .set('X-Device-Key', 'tablet-c');
    }
    const blocked = await http().get('/v1/health').set('X-Device-Key', 'tablet-c');
    expectProblem(blocked, 429, 'RATE_LIMITED');
  });

  it('sends no X-RateLimit headers', async () => {
    const res = await http().get('/v1/health').set('X-Device-Key', 'tablet-d');
    expect(Object.keys(res.headers).filter((h) => h.startsWith('x-ratelimit'))).toEqual([]);
  });
});

describe('logs (doc 03 §5.8)', () => {
  it('never contain the device key, the token or cookies', async () => {
    await http()
      .get('/v1/health')
      .set('X-Device-Key', 'device-key-must-not-leak')
      .set('Authorization', 'Bearer token-must-not-leak')
      .set('Cookie', 'm100_admin=cookie-must-not-leak');
    expect(logs.text).toContain('[redacted]');
    expect(logs.text).not.toMatch(
      /device-key-must-not-leak|token-must-not-leak|cookie-must-not-leak/,
    );
  });
});
