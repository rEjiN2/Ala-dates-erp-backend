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
  PendingQueryDto,
  RejectCashHandoverDto,
} from './dto/cash-handover.dto.js';

/**
 * Every route needs a cash-handovers permission; the actor always comes from
 * the token. "own"-scoped users only ever see their own handovers (others are
 * 404) and never approve or reject.
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

  /** The user's cash, wallet and cheque balances: what they hold and may still hand over. */
  @Get('pending')
  @RequirePermission(Permission.CASH_HANDOVERS_READ)
  pending(@Query() query: PendingQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashHandoverService.pending(query, user);
  }

  @Get(':id')
  @RequirePermission(Permission.CASH_HANDOVERS_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.cashHandoverService.findById(id, user);
  }

  /** CASH HANDOVER SLIP as an A4 PDF, shown inline. Every call is a print: it is audited. */
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

  @Post()
  @RequirePermission(Permission.CASH_HANDOVERS_CREATE)
  create(@Body() dto: CreateCashHandoverDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashHandoverService.create(dto, user);
  }

  @Post(':id/approve')
  @RequirePermission(Permission.CASH_HANDOVERS_APPROVE)
  approve(@Param('id') id: string, @Body() dto: ApproveCashHandoverDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashHandoverService.approve(id, dto, user);
  }

  @Post(':id/reject')
  @RequirePermission(Permission.CASH_HANDOVERS_APPROVE)
  reject(@Param('id') id: string, @Body() dto: RejectCashHandoverDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashHandoverService.reject(id, dto, user);
  }

  /** Submitted: the submitter (needs only :create) or cash-handovers:cancel. Approved: cash-handovers:cancel. */
  @Post(':id/cancel')
  @RequirePermission(Permission.CASH_HANDOVERS_CREATE)
  cancel(@Param('id') id: string, @Body() dto: CancelCashHandoverDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashHandoverService.cancel(id, dto, user);
  }
}
