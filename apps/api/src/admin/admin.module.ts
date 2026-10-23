import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MasterDataModule } from '../master-data/master-data.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminDb } from './admin-db';
import { AdminTokens } from './admin-session';
import { AdminGuard } from './admin.guard';
import { MasterAdminController } from './master/master-admin.controller';
import { MasterAdminService } from './master/master-admin.service';
import { MasterImportsService } from './master/master-imports.service';

/**
 * `AdminModule` of doc 03 §5.1: the admin API of doc 04 §8. T3b.1 brings the session (login, logout, `/me`, own
 * password) and `AdminGuard`, bound globally by `AppModule` after the tablet guards; T3b.2 the master data and its
 * imports.
 */
@Module({
  imports: [AuthModule, MasterDataModule],
  controllers: [AdminAuthController, MasterAdminController],
  providers: [
    AdminTokens,
    AdminDb,
    AdminAuthService,
    AdminGuard,
    MasterAdminService,
    MasterImportsService,
  ],
  exports: [AdminGuard],
})
export class AdminModule {}
