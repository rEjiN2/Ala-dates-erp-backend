import { Body, Controller, Get, Header, Param, Patch, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { CashPaymentService } from './cash-payment.service.js';
import {
  CancelCashPaymentDto,
  CashPaymentQueryDto,
  CreateCashPaymentDto,
  UpdateCashPaymentDto,
} from './dto/cash-payment.dto.js';
import { voucherView } from '../vouchers/voucher-view.js';

/**
 * Every route needs a cash-payments permission; the actor always comes from
 * the token. "own"-scoped users only ever see their own payments (others are
 * 404). Line balances need balances:view.
 */
@Controller('cash-payments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CashPaymentController {
  constructor(private readonly cashPaymentService: CashPaymentService) {}

  @Get()
  @RequirePermission(Permission.CASH_PAYMENTS_READ)
  findAll(@Query() query: CashPaymentQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashPaymentService.findAll(query, user);
  }

  @Get(':id')
  @RequirePermission(Permission.CASH_PAYMENTS_READ)
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return voucherView(await this.cashPaymentService.findById(id, user), user);
  }

  /** The voucher as an A4 PDF, shown inline. Every call is a print: it is audited, and later copies are DUPLICATEs. */
  @Get(':id/pdf')
  @RequirePermission(Permission.CASH_PAYMENTS_READ)
  @Header('Cache-Control', 'private, no-store')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<StreamableFile> {
    const printed = await this.cashPaymentService.print(id, user);
    return new StreamableFile(printed.buffer, {
      type: 'application/pdf',
      length: printed.buffer.length,
      disposition: `inline; filename="${printed.filename}"`,
    });
  }

  @Post()
  @RequirePermission(Permission.CASH_PAYMENTS_CREATE)
  async create(@Body() dto: CreateCashPaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView(await this.cashPaymentService.create(dto, user), user);
  }

  @Patch(':id')
  @RequirePermission(Permission.CASH_PAYMENTS_EDIT)
  async update(@Param('id') id: string, @Body() dto: UpdateCashPaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView(await this.cashPaymentService.update(id, dto, user), user);
  }

  @Post(':id/cancel')
  @RequirePermission(Permission.CASH_PAYMENTS_CANCEL)
  async cancel(@Param('id') id: string, @Body() dto: CancelCashPaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView(await this.cashPaymentService.cancel(id, dto, user), user);
  }
}
