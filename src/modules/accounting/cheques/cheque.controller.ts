import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { ChequeService } from './cheque.service.js';
import { ChequeQueryDto, ClearChequeDto, DepositChequeDto, ReturnChequeDto, UndoChequeDto } from './dto/cheque.dto.js';
import { voucherView } from '../vouchers/voucher-view.js';
import type { VoucherDocument } from '../vouchers/schemas/voucher.schema.js';

/**
 * Cheques received on cash receipts; the id is the receipt's. "own"-scoped
 * users see only cheques on their own receipts (others are 404).
 */
@Controller('cheques')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ChequeController {
  constructor(private readonly chequeService: ChequeService) {}

  @Get()
  @RequirePermission(Permission.CHEQUES_READ)
  findAll(@Query() query: ChequeQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.chequeService.findAll(query, user);
  }

  @Post(':id/deposit')
  @RequirePermission(Permission.CHEQUES_DEPOSIT)
  async deposit(@Param('id') id: string, @Body() dto: DepositChequeDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView((await this.chequeService.deposit(id, dto, user)) as unknown as VoucherDocument, user);
  }

  @Post(':id/clear')
  @RequirePermission(Permission.CHEQUES_CLEAR)
  async clear(@Param('id') id: string, @Body() dto: ClearChequeDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView((await this.chequeService.clear(id, dto, user)) as unknown as VoucherDocument, user);
  }

  @Post(':id/return')
  @RequirePermission(Permission.CHEQUES_RETURN)
  async return(@Param('id') id: string, @Body() dto: ReturnChequeDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView((await this.chequeService.return(id, dto, user)) as unknown as VoucherDocument, user);
  }

  /** Admin only (checked in the service): undoes the last deposit, clearance or return. */
  @Post(':id/undo')
  @RequirePermission(Permission.CHEQUES_READ)
  async undo(@Param('id') id: string, @Body() dto: UndoChequeDto, @CurrentUser() user: AuthenticatedUser) {
    return voucherView((await this.chequeService.undo(id, dto, user)) as unknown as VoucherDocument, user);
  }
}
