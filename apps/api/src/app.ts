import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { assignRequestId } from './logging/logging.module';

/** Request body limit (doc 04 §7). */
export const BODY_LIMIT = '8mb';

/**
 * Settings that live on the application rather than in a module. `main.ts` and the tests both call this, so
 * the tests exercise the same app that runs on the server.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  app.use(assignRequestId);
  app.useLogger(app.get(Logger));
  // Caddy forwards `/v1/*` without stripping the prefix (doc 03 §7.2.1) and is the only client of the API.
  app.setGlobalPrefix('v1');
  app.set('trust proxy', 'loopback');
  app.useBodyParser('json', { limit: BODY_LIMIT });
  return app;
}
