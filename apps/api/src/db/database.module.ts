import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Config } from '../config/env';
import { ADMIN_REPOSITORY, PgAdminRepository } from '../repositories/admin.repository';
import { AUDIT_LOG_REPOSITORY, PgAuditLogRepository } from '../repositories/audit-log.repository';
import { DEVICE_REPOSITORY, PgDeviceRepository } from '../repositories/device.repository';
import {
  MASTER_ADMIN_REPOSITORY,
  TypeOrmMasterAdminRepository,
} from '../repositories/master-admin.repository';
import {
  MASTER_DATA_REPOSITORY,
  PgMasterDataRepository,
} from '../repositories/master-data.repository';
import { PgPoRepository, PO_REPOSITORY } from '../repositories/po.repository';
import { PgReadinessRepository, READINESS_REPOSITORY } from '../repositories/readiness.repository';
import { PgSettingsRepository, SETTINGS_REPOSITORY } from '../repositories/settings.repository';
import {
  PgSubmissionRepository,
  SUBMISSION_REPOSITORY,
} from '../repositories/submission.repository';
import { createPool, Database } from './database';
import { AdminDataSource } from './typeorm';

const REPOSITORIES = [
  [SETTINGS_REPOSITORY, PgSettingsRepository],
  [MASTER_DATA_REPOSITORY, PgMasterDataRepository],
  [PO_REPOSITORY, PgPoRepository],
  [DEVICE_REPOSITORY, PgDeviceRepository],
  [ADMIN_REPOSITORY, PgAdminRepository],
  [AUDIT_LOG_REPOSITORY, PgAuditLogRepository],
  [SUBMISSION_REPOSITORY, PgSubmissionRepository],
  [READINESS_REPOSITORY, PgReadinessRepository],
] as const;

/**
 * The pool (role `m100_app`, `DATABASE_URL`) and every repository, bound to its interface token (doc 03 §5.1,
 * §5.2). The pool connects lazily, on the first query; so does the TypeORM `DataSource` of the admin CRUD.
 */
@Global()
@Module({
  providers: [
    {
      provide: Database,
      useFactory: (config: Config) => new Database(createPool(config.databaseUrl, 'm100 api')),
      inject: [APP_CONFIG],
    },
    ...REPOSITORIES.map(([token, Repository]) => ({
      provide: token,
      useFactory: (db: Database) => new Repository(db),
      inject: [Database],
    })),
    {
      provide: AdminDataSource,
      useFactory: (config: Config) => new AdminDataSource(config.databaseUrl),
      inject: [APP_CONFIG],
    },
    {
      provide: MASTER_ADMIN_REPOSITORY,
      useFactory: (source: AdminDataSource) => new TypeOrmMasterAdminRepository(source),
      inject: [AdminDataSource],
    },
  ],
  exports: [Database, MASTER_ADMIN_REPOSITORY, ...REPOSITORIES.map(([token]) => token)],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AdminDataSource) private readonly adminSource: AdminDataSource,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.adminSource.destroy();
    await this.db.end();
  }
}
