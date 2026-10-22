import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/auth.decorator';
import { type SubmissionResult, SubmissionService } from './submission.service';

/**
 * `POST /v1/submissions` (doc 04 §4): one Submit PO as `multipart/form-data`. Needs the device key and the user
 * token (doc 04 §2), the default for a route without `@Auth`. `201` written now, `200` written before.
 */
@Controller('submissions')
export class SubmissionsController {
  constructor(@Inject(SubmissionService) private readonly service: SubmissionService) {}

  @Post()
  async create(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmissionResult> {
    // The guards have set both; the body is read from the request stream by the service.
    const { status, body } = await this.service.submit(req, req.device!, req.tablet!);
    res.status(status);
    return body;
  }
}
