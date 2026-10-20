/**
 * The API's environment (doc 03 §7.4), checked once at start-up. A missing or malformed variable stops the
 * process with every offending name (T2.1). Values are only checked here; files and connections are opened by
 * the modules that use them.
 */
import { z } from 'zod';

const required = z.string().trim().min(1, 'is missing');
const seconds = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const schema = z
  .object({
    DATABASE_URL: required.regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    PHOTO_STORE: z.enum(['disk', 's3'], { error: 'must be disk or s3' }),
    PHOTO_DIR: z.string().trim().optional(),
    S3_ENDPOINT: z.string().trim().optional(),
    S3_BUCKET: z.string().trim().optional(),
    S3_ACCESS_KEY: z.string().trim().optional(),
    S3_SECRET_KEY: z.string().trim().optional(),
    JWT_KEY_FILE: required,
    TZ: z.literal('Asia/Jakarta', { error: 'must be Asia/Jakarta' }),
    MASTER_CHECK_SECONDS: seconds(300),
    SUBMIT_TIMEOUT_SECONDS: seconds(60),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  })
  .superRefine((env, ctx) => {
    const needed =
      env.PHOTO_STORE === 'disk'
        ? (['PHOTO_DIR'] as const)
        : env.PHOTO_STORE === 's3'
          ? (['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const)
          : [];
    for (const name of needed) {
      if (!env[name]) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `is missing (PHOTO_STORE=${env.PHOTO_STORE})`,
        });
      }
    }
  });

export interface Config {
  databaseUrl: string;
  photoStore:
    | { kind: 'disk'; dir: string }
    | { kind: 's3'; endpoint: string; bucket: string; accessKey: string; secretKey: string };
  jwtKeyFile: string;
  masterCheckSeconds: number;
  submitTimeoutSeconds: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  port: number;
}

/** Thrown by `loadConfig`; `variables` names every variable that is missing or wrong. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly { variable: string; message: string }[]) {
    super(
      `Invalid configuration:\n${problems.map((p) => `  ${p.variable} ${p.message}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }

  get variables(): string[] {
    return this.problems.map((p) => p.variable);
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        variable: String(issue.path[0]),
        message: env[String(issue.path[0])] === undefined ? 'is missing' : issue.message,
      })),
    );
  }
  const e = result.data;
  return {
    databaseUrl: e.DATABASE_URL,
    photoStore:
      e.PHOTO_STORE === 'disk'
        ? { kind: 'disk', dir: e.PHOTO_DIR! }
        : {
            kind: 's3',
            endpoint: e.S3_ENDPOINT!,
            bucket: e.S3_BUCKET!,
            accessKey: e.S3_ACCESS_KEY!,
            secretKey: e.S3_SECRET_KEY!,
          },
    jwtKeyFile: e.JWT_KEY_FILE,
    masterCheckSeconds: e.MASTER_CHECK_SECONDS,
    submitTimeoutSeconds: e.SUBMIT_TIMEOUT_SECONDS,
    logLevel: e.LOG_LEVEL,
    port: e.PORT,
  };
}
