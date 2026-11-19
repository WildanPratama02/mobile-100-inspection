import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Auth, type AuthRequest } from '../../auth/auth.decorator';
import { type AdminRevisionHistory, RevisionsAdminService } from './revisions-admin.service';
import type { AdminSubmissionDetail } from './submissions-admin.service';

/**
 * Corrections of a submission (ADR-024, doc 04 §8.1): the history and a new revision. Needs the admin session and,
 * for the `POST`, `X-Requested-With: m100-admin` (`AdminGuard`). Nothing here changes or deletes a stored row.
 */
@Controller('admin/submissions')
@Auth('admin')
export class RevisionsAdminController {
  constructor(@Inject(RevisionsAdminService) private readonly revisions: RevisionsAdminService) {}

  @Get(':id/revisions')
  history(@Param('id') id: string): Promise<AdminRevisionHistory> {
    return this.revisions.history(id);
  }

  @Post(':id/revisions')
  async create(
    @Param('id') id: string,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminSubmissionDetail> {
    // The guard has set `req.admin`; the body is read from the request stream by the service.
    const { status, body } = await this.revisions.create(id, req, req.admin!);
    res.status(status);
    return body;
  }
}
