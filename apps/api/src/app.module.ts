import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { DestinationStream } from 'pino';
import { ConfigModule } from './config/config.module';
import type { Config } from './config/env';
import { DatabaseModule } from './db/database.module';
import { ProblemFilter } from './errors/problem.filter';
import { HealthModule } from './health/health.module';
import { LoggingModule } from './logging/logging.module';
import { MasterDataModule } from './master-data/master-data.module';
import { PhotoStoreModule } from './photos/photo-store.module';
import { DeviceThrottlerGuard, RATE_LIMIT } from './throttle/device-throttler.guard';

export interface AppModuleOptions {
  /** Replaces stdout as the log destination (tests). */
  logDestination?: DestinationStream;
}

/** Root module. Feature modules of doc 03 §5.1 are added task by task. */
@Module({})
export class AppModule {
  static forConfig(config: Config, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forConfig(config),
        LoggingModule.forConfig(config, options.logDestination),
        ThrottlerModule.forRoot({ throttlers: [RATE_LIMIT], setHeaders: false }),
        DatabaseModule,
        PhotoStoreModule,
        HealthModule,
        MasterDataModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: DeviceThrottlerGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}
