import { Body, Controller, Get, Header, Param, Patch, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { SalesInvoiceService } from './sales-invoice.service.js';
import {
  CancelSalesInvoiceDto,
  CreateSalesInvoiceDto,
  SalesInvoiceQueryDto,
  UpdateSalesInvoiceDto,
} from './dto/sales-invoice.dto.js';

/** Every route needs a sales-invoices permission; the actor always comes from the token. */
@Controller('sales-invoices')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SalesInvoiceController {
  constructor(private readonly salesInvoiceService: SalesInvoiceService) {}

  @Get()
  @RequirePermission(Permission.SALES_INVOICES_READ)
  findAll(@Query() query: SalesInvoiceQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesInvoiceService.findAll(query, user);
  }

  @Get(':id')
  @RequirePermission(Permission.SALES_INVOICES_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.salesInvoiceService.detail(id, user);
  }

  /** The TAX INVOICE as an A4 PDF, shown inline. Every call is a print: it is audited, and later copies are DUPLICATEs. */
  @Get(':id/pdf')
  @RequirePermission(Permission.SALES_INVOICES_READ)
  @Header('Cache-Control', 'private, no-store')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<StreamableFile> {
    const printed = await this.salesInvoiceService.print(id, user);
    return new StreamableFile(printed.buffer, {
      type: 'application/pdf',
      length: printed.buffer.length,
      disposition: `inline; filename="${printed.filename}"`,
    });
  }

  @Post()
  @RequirePermission(Permission.SALES_INVOICES_CREATE)
  async create(@Body() dto: CreateSalesInvoiceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesInvoiceService.view(await this.salesInvoiceService.create(dto, user), user);
  }

  @Patch(':id')
  @RequirePermission(Permission.SALES_INVOICES_EDIT)
  async update(@Param('id') id: string, @Body() dto: UpdateSalesInvoiceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesInvoiceService.view(await this.salesInvoiceService.update(id, dto, user), user);
  }

  @Post(':id/cancel')
  @RequirePermission(Permission.SALES_INVOICES_CANCEL)
  async cancel(@Param('id') id: string, @Body() dto: CancelSalesInvoiceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesInvoiceService.view(await this.salesInvoiceService.cancel(id, dto, user), user);
  }
}
