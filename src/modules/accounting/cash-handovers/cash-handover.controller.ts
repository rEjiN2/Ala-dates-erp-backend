import { Body, Controller, Get, Header, Param, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { CashHandoverService } from './cash-handover.service.js';
import {
  ApproveCashHandoverDto,
  CancelCashHandoverDto,
  CashHandoverQueryDto,
  CreateCashHandoverDto,
  RejectCashHandoverDto,
  UnsettledReceiptsQueryDto,
} from './dto/cash-handover.dto.js';
import { voucherView } from '../vouchers/voucher-view.js';

/**
 * Every route needs a cash-handovers permission; the actor always comes from
 * the token. "own"-scoped users only ever see their own staff record's
 * handovers (others are 404). Line balances need balances:view.
 */
@Controller('cash-handovers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CashHandoverController {
  constructor(private readonly cashHandoverService: CashHandoverService) {}

  @Get()
  @RequirePermission(Permission.CASH_HANDOVERS_READ)
  findAll(@Query() query: CashHandoverQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashHandoverService.findAll(query, user);
  }

  /** Receipts a new handover can include. Declared before :id. */
  @Get('unsettled')
  @RequirePermission(Permission.CASH_HANDOVERS_CREATE)
  unsettled(@Query() query: UnsettledReceiptsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashHandoverService.unsettled(query, user);
  }

  @Get(':id')
  @RequirePermission(Permission.CASH_HANDOVERS_READ)
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return voucherView(await this.cashHandoverService.findById(id, user), user);
  }

  /** CASH HANDOVER SLIP as an A4 PDF, shown inline. Every call is a print: it is audited, and later copies are DUPLICATEs. */
  @Get(':id/pdf')
  @RequirePermission(Permission.CASH_HANDOVERS_READ)
  @Header('Cache-Control', 'private, no-store')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<StreamableFile> {
    const printed = await this.cashHandoverService.print(id, user);
    return new StreamableFile(printed.buffer, {
      type: 'application/pdf',
      length: printed.buffer.length,
      disposition: `inline; filename="${printed.filename}"`,
    });
  }

  /** Submit. */
  @Post()
  @RequirePermission(Permission.CASH_HANDOVERS_CREATE)
  async create(@Body() dto: CreateCashHandoverDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView(await this.cashHandoverService.create(dto, user), user);
  }

  @Post(':id/approve')
  @RequirePermission(Permission.CASH_HANDOVERS_APPROVE)
  async approve(@Param('id') id: string, @Body() dto: ApproveCashHandoverDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView(await this.cashHandoverService.approve(id, dto, user), user);
  }

  @Post(':id/reject')
  @RequirePermission(Permission.CASH_HANDOVERS_APPROVE)
  async reject(@Param('id') id: string, @Body() dto: RejectCashHandoverDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView(await this.cashHandoverService.reject(id, dto, user), user);
  }

  /** The service decides: the submitter may cancel their submitted handover; anything else needs cash-handovers:cancel. */
  @Post(':id/cancel')
  @RequirePermission(Permission.CASH_HANDOVERS_READ)
  async cancel(@Param('id') id: string, @Body() dto: CancelCashHandoverDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView(await this.cashHandoverService.cancel(id, dto, user), user);
  }
}
