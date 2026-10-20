import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Options } from 'pino-http';
import type { Config } from '../config/env';

/** Never in the log (doc 03 §5.8): device keys, tokens, cookies. */
export const REDACTED_PATHS = [
  'req.headers["x-device-key"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/**
 * Gives every request a fresh id and returns it as `X-Request-Id` (doc 04 §1). Mounted on the HTTP server
 * itself (`configureApp`), so it also covers paths outside `/v1` that no Nest middleware sees.
 */
export function assignRequestId(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

/**
 * JSON logs with pino; every request line carries the id of `assignRequestId` as `req.id`. Output goes to
 * stdout; the service wrapper captures it (files and rotation: T4.1).
 */
@Module({})
export class LoggingModule {
  /** `destination` replaces stdout, for tests. */
  static forConfig(config: Config, destination?: DestinationStream): DynamicModule {
    const options: Options = {
      level: config.logLevel,
      genReqId: (req) => req.id ?? randomUUID(),
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    };
    return {
      module: LoggingModule,
      imports: [LoggerModule.forRoot({ pinoHttp: destination ? [options, destination] : options })],
    };
  }
}
