import { Module } from '@nestjs/common';
import { MasterDataController } from './master-data.controller';
import { MasterDataService } from './master-data.service';
import { ReadinessService } from './readiness.service';
import { SystemController } from './system.controller';

/** `MasterDataModule` of doc 03 §5.1: the cached `/master-data`, `/system/status` and the readiness checks. */
@Module({
  controllers: [MasterDataController, SystemController],
  providers: [MasterDataService, ReadinessService],
  exports: [ReadinessService],
})
export class MasterDataModule {}
