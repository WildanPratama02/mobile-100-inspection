import { Controller, Get, Inject } from '@nestjs/common';
import { Auth } from '../auth/auth.decorator';
import { ReadinessService, type SystemStatus } from './readiness.service';

/**
 * `GET /v1/system/status` (doc 04 §3): the result of the last readiness checks (doc 02 §10). Needs only the device
 * key; the setup page uses it to check a new key (doc 03 §4.9).
 */
@Controller('system')
@Auth('device')
export class SystemController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  @Get('status')
  status(): SystemStatus {
    return this.readiness.current();
  }
}
