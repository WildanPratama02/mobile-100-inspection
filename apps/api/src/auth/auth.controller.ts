import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Auth, type AuthRequest } from './auth.decorator';
import { type LoginResponse, AuthService } from './auth.service';
import { bearerToken } from './tablet-token';

/**
 * `POST /v1/auth/login` and `POST /v1/auth/refresh` (doc 04 §2, §3.1). Both need only the device key: login comes
 * before any token, and refresh checks its token itself because it also takes a recently expired one.
 */
@Controller('auth')
@Auth('device')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: AuthRequest): Promise<LoginResponse> {
    return this.auth.login(body, req.device!);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Req() req: AuthRequest): LoginResponse {
    return this.auth.refresh(bearerToken(req.headers.authorization), req.device!);
  }
}
