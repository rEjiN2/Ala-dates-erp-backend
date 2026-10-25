import { Body, Controller, Get, Header, Param, Patch, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { PurchaseInvoiceService } from './purchase-invoice.service.js';
import {
  CancelPurchaseInvoiceDto,
  CreatePurchaseInvoiceDto,
  PurchaseInvoiceQueryDto,
  UpdatePurchaseInvoiceDto,
} from './dto/purchase-invoice.dto.js';

/** Every route needs a purchase-invoices permission; the actor always comes from the token. */
@Controller('purchase-invoices')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PurchaseInvoiceController {
  constructor(private readonly purchaseInvoiceService: PurchaseInvoiceService) {}

  @Get()
  @RequirePermission(Permission.PURCHASE_INVOICES_READ)
  findAll(@Query() query: PurchaseInvoiceQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseInvoiceService.findAll(query, user);
  }

  @Get(':id')
  @RequirePermission(Permission.PURCHASE_INVOICES_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseInvoiceService.detail(id, user);
  }

  /** The invoice as an A4 PDF, shown inline. Every call is a print: it is audited, and later copies are DUPLICATEs. */
  @Get(':id/pdf')
  @RequirePermission(Permission.PURCHASE_INVOICES_READ)
  @Header('Cache-Control', 'private, no-store')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<StreamableFile> {
    const printed = await this.purchaseInvoiceService.print(id, user);
    return new StreamableFile(printed.buffer, {
      type: 'application/pdf',
      length: printed.buffer.length,
      disposition: `inline; filename="${printed.filename}"`,
    });
  }

  @Post()
  @RequirePermission(Permission.PURCHASE_INVOICES_CREATE)
  create(@Body() dto: CreatePurchaseInvoiceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseInvoiceService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission(Permission.PURCHASE_INVOICES_EDIT)
  update(@Param('id') id: string, @Body() dto: UpdatePurchaseInvoiceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseInvoiceService.update(id, dto, user);
  }

  @Post(':id/cancel')
  @RequirePermission(Permission.PURCHASE_INVOICES_CANCEL)
  cancel(@Param('id') id: string, @Body() dto: CancelPurchaseInvoiceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseInvoiceService.cancel(id, dto, user);
  }
}
