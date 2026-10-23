import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Auth, type AuthRequest } from '../auth/auth.decorator';
import { type AdminMe, AdminAuthService } from './admin-auth.service';
import { clearedCookie, sessionCookie } from './admin-session';

/**
 * `/v1/admin/auth/login`, `/v1/admin/auth/logout`, `/v1/admin/me` and `/v1/admin/me/password` (doc 04 §8). Login
 * sets the session cookie; everything else needs it (`AdminGuard`).
 */
@Controller('admin')
@Auth('admin')
export class AdminAuthController {
  constructor(@Inject(AdminAuthService) private readonly auth: AdminAuthService) {}

  @Post('auth/login')
  @Auth('admin-login')
  @HttpCode(204)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<void> {
    res.setHeader('Set-Cookie', sessionCookie(await this.auth.login(body)));
  }

  @Post('auth/logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.setHeader('Set-Cookie', clearedCookie());
  }

  @Get('me')
  me(@Req() req: AuthRequest): Promise<AdminMe> {
    return this.auth.me(req.admin!);
  }

  @Post('me/password')
  @HttpCode(204)
  changePassword(@Body() body: unknown, @Req() req: AuthRequest): Promise<void> {
    return this.auth.changePassword(req.admin!, body);
  }
}
