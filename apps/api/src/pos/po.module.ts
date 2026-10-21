import { Module } from '@nestjs/common';
import { MasterDataModule } from '../master-data/master-data.module';
import { PoController } from './po.controller';
import { PoService } from './po.service';

/** `PoModule` of doc 03 §5.1: the PO search with `pg_trgm` and one PO by number. */
@Module({
  imports: [MasterDataModule],
  controllers: [PoController],
  providers: [PoService],
})
export class PoModule {}
