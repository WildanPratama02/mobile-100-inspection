import { Module } from '@nestjs/common';
import { MasterDataModule } from '../master-data/master-data.module';
import { CorrectionsController } from './corrections.controller';
import { CorrectionsService } from './corrections.service';
import { SubmissionService } from './submission.service';
import { SubmissionValidator } from './submission-validator';
import { SubmissionsController } from './submissions.controller';

/**
 * `SubmissionsModule` of doc 03 §5.1: `POST /submissions`, request parsing (`readSubmissionParts`), validation
 * (doc 04 §4.2) and the write procedure (doc 03 §5.4); the tablet's reads of admin corrections (doc 04 §3.4,
 * ADR-023).
 */
@Module({
  imports: [MasterDataModule],
  controllers: [SubmissionsController, CorrectionsController],
  providers: [SubmissionValidator, SubmissionService, CorrectionsService],
  exports: [SubmissionValidator],
})
export class SubmissionsModule {}
