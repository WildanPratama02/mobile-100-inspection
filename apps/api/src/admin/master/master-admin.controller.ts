import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Auth, type AuthRequest } from '../../auth/auth.decorator';
import { ApiProblem } from '../../errors/problem';
import type {
  AdminAreaMap,
  AdminCell,
  AdminDefect,
  AdminFactory,
  AdminMapRow,
  AdminPo,
  AdminPsiUser,
} from '../../repositories/master-admin.repository';
import { readUpload } from '../upload';
import { MasterAdminService } from './master-admin.service';
import { type ImportReport, MasterImportsService } from './master-imports.service';

/**
 * The master-data endpoints of doc 04 §8: PSI users, factories and cells, POs and their import, defects and the
 * area map and its import. All need the admin session (`AdminGuard`); a change also needs `X-Requested-With`.
 */
@Controller('admin')
@Auth('admin')
export class MasterAdminController {
  constructor(
    @Inject(MasterAdminService) private readonly master: MasterAdminService,
    @Inject(MasterImportsService) private readonly imports: MasterImportsService,
  ) {}

  @Get('psi-users')
  psiUsers(): Promise<AdminPsiUser[]> {
    return this.master.psiUsers();
  }

  @Post('psi-users')
  createPsiUser(@Req() req: AuthRequest, @Body() body: unknown): Promise<AdminPsiUser> {
    return this.master.createPsiUser(req.admin!, body);
  }

  @Patch('psi-users/:id')
  updatePsiUser(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminPsiUser> {
    return this.master.updatePsiUser(req.admin!, id, body);
  }

  @Get('factories')
  factories(): Promise<AdminFactory[]> {
    return this.master.factories();
  }

  @Post('factories')
  createFactory(@Req() req: AuthRequest, @Body() body: unknown): Promise<AdminFactory> {
    return this.master.createFactory(req.admin!, body);
  }

  @Patch('factories/:id')
  updateFactory(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminFactory> {
    return this.master.updateFactory(req.admin!, id, body);
  }

  @Get('cells')
  cells(@Query() query: unknown): Promise<AdminCell[]> {
    return this.master.cells(query);
  }

  @Post('cells')
  createCell(@Req() req: AuthRequest, @Body() body: unknown): Promise<AdminCell> {
    return this.master.createCell(req.admin!, body);
  }

  @Patch('cells/:id')
  updateCell(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminCell> {
    return this.master.updateCell(req.admin!, id, body);
  }

  @Get('pos')
  searchPos(@Query() query: unknown): Promise<AdminPo[]> {
    return this.master.searchPos(query);
  }

  @Post('pos')
  createPo(@Req() req: AuthRequest, @Body() body: unknown): Promise<AdminPo> {
    return this.master.createPo(req.admin!, body);
  }

  @Post('pos/import')
  @HttpCode(200)
  async importPos(
    @Req() req: AuthRequest,
    @Query('dryRun') dryRun: unknown,
  ): Promise<ImportReport> {
    // The body is read first, also when the query is wrong, so the browser always gets the answer.
    const upload = await readUpload(req);
    return this.imports.importPos(req.admin!, upload, dryRunOf(dryRun));
  }

  @Patch('pos/:po')
  updatePo(
    @Req() req: AuthRequest,
    @Param('po') po: string,
    @Body() body: unknown,
  ): Promise<AdminPo> {
    return this.master.updatePo(req.admin!, po, body);
  }

  @Get('defects')
  defects(): Promise<AdminDefect[]> {
    return this.master.defects();
  }

  @Patch('defects/:id')
  updateDefect(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminDefect> {
    return this.master.updateDefect(req.admin!, id, body);
  }

  @Get('area-map')
  areaMap(): Promise<AdminAreaMap> {
    return this.master.areaMap();
  }

  @Post('area-map/import')
  @HttpCode(200)
  async importAreaMap(
    @Req() req: AuthRequest,
    @Query('dryRun') dryRun: unknown,
  ): Promise<ImportReport> {
    const upload = await readUpload(req);
    return this.imports.importAreaMap(req.admin!, upload, dryRunOf(dryRun));
  }

  @Patch('area-map/:id')
  updateMapRow(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminMapRow> {
    return this.master.updateMapRow(req.admin!, id, body);
  }
}

/** `dryRun` defaults to `true` (`04-openapi.yaml`): only an explicit `false` applies an import. */
function dryRunOf(value: unknown): boolean {
  if (value === undefined || value === 'true') return true;
  if (value === 'false') return false;
  throw new ApiProblem('VALIDATION_FAILED', {
    detail: 'Data tidak lengkap: dryRun',
    errors: [{ path: 'dryRun', code: 'INVALID', message: 'dryRun harus true atau false.' }],
  });
}
