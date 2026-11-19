import { Controller, Get, Header, Inject, Param, Query, Req, StreamableFile } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth.decorator';
import { cutOnFailure } from '../admin/submissions/submissions-admin.controller';
import { type Correction, CorrectionsService } from './corrections.service';

/**
 * The tablet's reads of admin corrections (ADR-024, doc 04 §3.4). Device key and user token, the default for a route
 * without `@Auth`; an admin cookie is no tablet token. Both count towards the device's rate limit.
 */
@Controller('submissions')
export class CorrectionsController {
  constructor(@Inject(CorrectionsService) private readonly corrections: CorrectionsService) {}

  @Get('corrections')
  @Header('Cache-Control', 'no-store')
  newest(@Query('ids') ids: unknown, @Req() req: AuthRequest): Promise<{ items: Correction[] }> {
    return this.corrections.newest(ids, req.tablet!);
  }

  @Get(':id/corrections/:revisionNo/photos/:defectId')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async photo(
    @Param('id') id: string,
    @Param('revisionNo') revisionNo: string,
    @Param('defectId') defectId: string,
    @Req() req: AuthRequest,
  ): Promise<StreamableFile> {
    const stream = await this.corrections.photo(id, revisionNo, defectId, req.tablet!);
    return cutOnFailure(new StreamableFile(stream, { type: 'image/jpeg' }));
  }
}
