import { Readable, type Writable } from 'node:stream';
import { Controller, Get, Header, Inject, Param, Query, StreamableFile } from '@nestjs/common';
import { Auth } from '../../auth/auth.decorator';
import { AdminPhotoRateLimit } from '../../throttle/device-throttler.guard';
import { CSV_CONTENT_TYPE } from './csv';
import {
  type AdminSubmissionDetail,
  type AdminSubmissionPage,
  SubmissionsAdminService,
} from './submissions-admin.service';

/**
 * The read-only submission endpoints of doc 04 §8: list, export, detail and photos. There is deliberately no
 * route that changes a submission (AC-14.4). All need the admin session (`AdminGuard`); a tablet token is refused.
 */
@Controller('admin')
@Auth('admin')
export class SubmissionsAdminController {
  constructor(
    @Inject(SubmissionsAdminService) private readonly submissions: SubmissionsAdminService,
  ) {}

  @Get('submissions')
  list(@Query() query: unknown): Promise<AdminSubmissionPage> {
    return this.submissions.list(query);
  }

  // Before `submissions/:id`, so `export.csv` is not taken for an id.
  @Get('submissions/export.csv')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async exportCsv(@Query() query: unknown): Promise<StreamableFile> {
    const { filename, chunks } = await this.submissions.exportCsv(query);
    return cutOnFailure(
      new StreamableFile(Readable.from(chunks), {
        type: CSV_CONTENT_TYPE,
        disposition: `attachment; filename="${filename}"`,
      }),
    );
  }

  @Get('submissions/:id')
  detail(@Param('id') id: string): Promise<AdminSubmissionDetail> {
    return this.submissions.detail(id);
  }

  @Get('photos/:id')
  @AdminPhotoRateLimit()
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async photo(@Param('id') id: string): Promise<StreamableFile> {
    return cutOnFailure(
      new StreamableFile(await this.submissions.photo(id), { type: 'image/jpeg' }),
    );
  }
}

/**
 * A read that fails after the headers went out cuts the connection. Nest's default ends the answer normally, which
 * would leave the admin with a cut-off CSV or JPEG that looks complete; a cut connection shows as a failed download.
 */
export function cutOnFailure(file: StreamableFile): StreamableFile {
  const before = file.errorHandler;
  return file.setErrorHandler((error, res) => {
    if (res.headersSent && !res.destroyed) {
      (res as unknown as Writable).destroy(error);
      return;
    }
    before(error, res);
  });
}
