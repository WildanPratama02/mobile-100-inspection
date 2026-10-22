import { Module } from '@nestjs/common';
import { SubmissionValidator } from './submission-validator';

/**
 * `SubmissionsModule` of doc 03 §5.1. T3.2: request parsing (`readSubmissionParts`) and validation (doc 04 §4.2);
 * the controller and the write procedure (doc 03 §5.4) follow in T3.3.
 */
@Module({
  providers: [SubmissionValidator],
  exports: [SubmissionValidator],
})
export class SubmissionsModule {}
