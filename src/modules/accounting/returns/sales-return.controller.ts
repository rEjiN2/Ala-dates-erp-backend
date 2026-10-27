import { Body, Controller, Get, Header, Param, Patch, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { SalesReturnService } from './sales-return.service.js';
import { CancelReturnDto, CreateSalesReturnDto, ReturnQueryDto, UpdateSalesReturnDto } from './dto/return.dto.js';

/** Every route needs a sales-returns permission; the actor always comes from the token. "own"-scoped users see only returns of their invoices. */
@Controller('sales-returns')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SalesReturnController {
  constructor(private readonly salesReturnService: SalesReturnService) {}

  @Get()
  @RequirePermission(Permission.SALES_RETURNS_READ)
  findAll(@Query() query: ReturnQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesReturnService.findAll(query, user);
  }

  @Get(':id')
  @RequirePermission(Permission.SALES_RETURNS_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.salesReturnService.detail(id, user);
  }

  /** The CREDIT NOTE as an A4 PDF, shown inline. Every call is a print: it is audited, and later copies are DUPLICATEs. */
  @Get(':id/pdf')
  @RequirePermission(Permission.SALES_RETURNS_READ)
  @Header('Cache-Control', 'private, no-store')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<StreamableFile> {
    const printed = await this.salesReturnService.print(id, user);
    return new StreamableFile(printed.buffer, {
      type: 'application/pdf',
      length: printed.buffer.length,
      disposition: `inline; filename="${printed.filename}"`,
    });
  }

  @Post()
  @RequirePermission(Permission.SALES_RETURNS_CREATE)
  async create(@Body() dto: CreateSalesReturnDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesReturnService.view(await this.salesReturnService.create(dto, user), user);
  }

  @Patch(':id')
  @RequirePermission(Permission.SALES_RETURNS_EDIT)
  async update(@Param('id') id: string, @Body() dto: UpdateSalesReturnDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesReturnService.view(await this.salesReturnService.update(id, dto, user), user);
  }

  @Post(':id/cancel')
  @RequirePermission(Permission.SALES_RETURNS_CANCEL)
  async cancel(@Param('id') id: string, @Body() dto: CancelReturnDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesReturnService.view(await this.salesReturnService.cancel(id, dto, user), user);
  }
}
