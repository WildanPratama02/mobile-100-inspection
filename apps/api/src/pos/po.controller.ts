import type { Po } from '@m100/shared';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { type PoSearchResponse, PoService } from './po.service';

/**
 * `GET /v1/pos?q=&limit=` and `GET /v1/pos/{po}` (doc 04 §3.3). Both need the device key and the user token
 * (doc 04 §2), the default for a route without `@Auth`.
 */
@Controller('pos')
export class PoController {
  constructor(@Inject(PoService) private readonly service: PoService) {}

  @Get()
  search(@Query() query: unknown): Promise<PoSearchResponse> {
    return this.service.search(query);
  }

  @Get(':po')
  get(@Param('po') po: string): Promise<Po> {
    return this.service.get(po);
  }
}
