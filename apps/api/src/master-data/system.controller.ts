import { Controller, Get, Inject } from '@nestjs/common';
import { ReadinessService, type SystemStatus } from './readiness.service';

/**
 * `GET /v1/system/status` (doc 04 §3): the result of the last readiness checks (doc 02 §10). The device key guard
 * comes with T2.5.
 */
@Controller('system')
export class SystemController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  @Get('status')
  status(): SystemStatus {
    return this.readiness.current();
  }
}
