import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type MasterDataDocument, MasterDataService } from './master-data.service';

/**
 * `GET /v1/master-data` (doc 04 §3.2): the document with `ETag` = `master_version`; `304` when `If-None-Match`
 * names the current version. The device key guard comes with T2.5.
 */
@Controller('master-data')
export class MasterDataController {
  constructor(@Inject(MasterDataService) private readonly service: MasterDataService) {}

  @Get()
  async get(
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<(MasterDataDocument & { fetchedAt: string }) | undefined> {
    const document = await this.service.current();
    res.setHeader('ETag', `"${document.version}"`);
    // The tablet must ask again each time; the ETag makes that cheap.
    res.setHeader('Cache-Control', 'no-cache');
    if (matches(ifNoneMatch, document.version)) {
      res.status(304);
      return undefined;
    }
    return { ...document, fetchedAt: new Date().toISOString() };
  }
}

/** `If-None-Match` names `version`: a list of tags, quoted or not, weak or strong, or `*`. */
export function matches(header: string | undefined, version: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((tag) =>
      tag
        .trim()
        .replace(/^W\//, '')
        .replace(/^"(.*)"$/, '$1'),
    )
    .some((tag) => tag === '*' || tag === version);
}
