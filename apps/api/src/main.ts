import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './app';
import { AppModule } from './app.module';
import { type Config, ConfigError, loadConfig } from './config/env';

interface Exit {
  exit(code: number): never;
  writeError(text: string): void;
}

/** The validated configuration, or the process stops and names every bad variable (doc 03 §7.4, T2.1). */
export function readConfigOrExit(env: NodeJS.ProcessEnv, exit: Exit): Config {
  try {
    return loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    exit.writeError(`${error.message}\n`);
    return exit.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  // `.env` in the install folder (doc 03 §7.4); the service wrapper starts the API there.
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const exit: Exit = {
    exit: (code) => process.exit(code),
    writeError: (text) => process.stderr.write(text),
  };
  const config = readConfigOrExit(process.env, exit);
  let app: NestExpressApplication;
  try {
    app = await NestFactory.create<NestExpressApplication>(AppModule.forConfig(config), {
      bufferLogs: true,
      abortOnError: false,
    });
  } catch (error) {
    // A file named by the configuration is unusable, e.g. JWT_KEY_FILE (T2.5).
    if (!(error instanceof ConfigError)) throw error;
    exit.writeError(`${error.message}\n`);
    return exit.exit(1);
  }
  configureApp(app);
  // Only Caddy listens on the network; the API stays on loopback (doc 03 §7.1).
  await app.listen(config.port, '127.0.0.1');
}

if (require.main === module) void bootstrap();
