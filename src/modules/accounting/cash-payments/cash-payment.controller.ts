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

/** Reads for any logged-in user; writes need cash-payments:manage. The actor always comes from the token. */
@Controller('cash-payments')
@UseGuards(JwtAuthGuard)
export class CashPaymentController {
  constructor(private readonly cashPaymentService: CashPaymentService) {}

  @Get()
  findAll(@Query() query: CashPaymentQueryDto) {
    return this.cashPaymentService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.cashPaymentService.findById(id);
  }

  /** The voucher as an A4 PDF, shown inline. Every call is a print: it is audited, and later copies are DUPLICATEs. */
  @Get(':id/pdf')
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
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.CASH_PAYMENTS_MANAGE)
  create(@Body() dto: CreateCashPaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashPaymentService.create(dto, user);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.CASH_PAYMENTS_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateCashPaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashPaymentService.update(id, dto, user);
  }

  @Post(':id/cancel')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.CASH_PAYMENTS_MANAGE)
  cancel(@Param('id') id: string, @Body() dto: CancelCashPaymentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashPaymentService.cancel(id, dto, user);
  }
}
