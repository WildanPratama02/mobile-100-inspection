import { Controller, Get } from '@nestjs/common';

/** `GET /v1/health`: liveness only, no authentication (doc 04 §2). Readiness is `/system/status` (T2.4). */
@Controller('health')
export class HealthController {
  @Get()
  get(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
