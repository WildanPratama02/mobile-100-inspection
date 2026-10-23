import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Auth, type AuthRequest } from '../../auth/auth.decorator';
import {
  type AdminAccount,
  AccountsAdminService,
  type AuditLogPage,
} from './accounts-admin.service';

/**
 * `/v1/admin/admins` and `/v1/admin/audit-log` (doc 04 §8). All need the admin session (`AdminGuard`); a change
 * also needs `X-Requested-With`. The audit log has no route that writes.
 */
@Controller('admin')
@Auth('admin')
export class AccountsAdminController {
  constructor(@Inject(AccountsAdminService) private readonly accounts: AccountsAdminService) {}

  @Get('admins')
  admins(): Promise<AdminAccount[]> {
    return this.accounts.admins();
  }

  @Post('admins')
  create(@Req() req: AuthRequest, @Body() body: unknown): Promise<AdminAccount> {
    return this.accounts.create(req.admin!, body);
  }

  @Patch('admins/:id')
  update(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminAccount> {
    return this.accounts.update(req.admin!, id, body);
  }

  @Get('audit-log')
  auditLog(@Query() query: unknown): Promise<AuditLogPage> {
    return this.accounts.auditLogPage(query);
  }
}
