import { Body, Controller, Get, Header, Param, Patch, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { PurchaseReturnService } from './purchase-return.service.js';
import { RefundReturnDto, CancelReturnDto, CreatePurchaseReturnDto, ReturnQueryDto, UpdatePurchaseReturnDto } from './dto/return.dto.js';

/** Every route needs a purchase-returns permission; the actor always comes from the token. "own"-scoped users see only their allowed locations. */
@Controller('purchase-returns')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PurchaseReturnController {
  constructor(private readonly purchaseReturnService: PurchaseReturnService) {}

  @Get()
  @RequirePermission(Permission.PURCHASE_RETURNS_READ)
  findAll(@Query() query: ReturnQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseReturnService.findAll(query, user);
  }

  @Get(':id')
  @RequirePermission(Permission.PURCHASE_RETURNS_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseReturnService.detail(id, user);
  }

  /** The DEBIT NOTE as an A4 PDF, shown inline. Every call is a print: it is audited, and later copies are DUPLICATEs. */
  @Get(':id/pdf')
  @RequirePermission(Permission.PURCHASE_RETURNS_READ)
  @Header('Cache-Control', 'private, no-store')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<StreamableFile> {
    const printed = await this.purchaseReturnService.print(id, user);
    return new StreamableFile(printed.buffer, {
      type: 'application/pdf',
      length: printed.buffer.length,
      disposition: `inline; filename="${printed.filename}"`,
    });
  }

  @Post()
  @RequirePermission(Permission.PURCHASE_RETURNS_CREATE)
  async create(@Body() dto: CreatePurchaseReturnDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseReturnService.view(await this.purchaseReturnService.create(dto, user), user);
  }

  @Patch(':id')
  @RequirePermission(Permission.PURCHASE_RETURNS_EDIT)
  async update(@Param('id') id: string, @Body() dto: UpdatePurchaseReturnDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseReturnService.view(await this.purchaseReturnService.update(id, dto, user), user);
  }

  /** Takes the credit left on account in cash from the supplier (posts a Cash Receipt). */
  @Post(':id/refund')
  @RequirePermission(Permission.PURCHASE_RETURNS_EDIT)
  async refund(@Param('id') id: string, @Body() dto: RefundReturnDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseReturnService.view(await this.purchaseReturnService.refund(id, dto, user), user);
  }

  @Post(':id/refunds/:voucherId/cancel')
  @RequirePermission(Permission.PURCHASE_RETURNS_EDIT)
  async cancelRefund(
    @Param('id') id: string,
    @Param('voucherId') voucherId: string,
    @Body() dto: CancelReturnDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchaseReturnService.view(await this.purchaseReturnService.cancelRefund(id, voucherId, dto, user), user);
  }

  @Post(':id/cancel')
  @RequirePermission(Permission.PURCHASE_RETURNS_CANCEL)
  async cancel(@Param('id') id: string, @Body() dto: CancelReturnDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseReturnService.view(await this.purchaseReturnService.cancel(id, dto, user), user);
  }
}
