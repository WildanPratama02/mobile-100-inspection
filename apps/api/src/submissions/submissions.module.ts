import { Module } from '@nestjs/common';
import { MasterDataModule } from '../master-data/master-data.module';
import { SubmissionService } from './submission.service';
import { SubmissionValidator } from './submission-validator';
import { SubmissionsController } from './submissions.controller';

/**
 * `SubmissionsModule` of doc 03 §5.1: `POST /submissions`, request parsing (`readSubmissionParts`), validation
 * (doc 04 §4.2) and the write procedure (doc 03 §5.4).
 */
@Module({
  imports: [MasterDataModule],
  controllers: [SubmissionsController],
  providers: [SubmissionValidator, SubmissionService],
  exports: [SubmissionValidator],
})
export class SubmissionsModule {}
