import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { Config } from './env';

/** Injection token of the validated `Config` (doc 03 §5.1 ConfigModule). */
export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({})
export class ConfigModule {
  static forConfig(config: Config): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
