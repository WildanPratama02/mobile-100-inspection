import { Controller, Get } from '@nestjs/common';
import { Auth } from '../auth/auth.decorator';

/** `GET /v1/health`: liveness only, no authentication (doc 04 §2). Readiness is `/system/status` (T2.4). */
@Controller('health')
@Auth('none')
export class HealthController {
  @Get()
  get(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
