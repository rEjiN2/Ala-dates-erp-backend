import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission, hasPermission } from '../../roles/permissions.js';
import type { LedgerAccountDocument } from './schemas/ledger-account.schema.js';
import { LedgerAccountService } from './ledger-account.service.js';
import { LedgerAccountLookupQueryDto, LedgerAccountQueryDto } from './dto/ledger-account-query.dto.js';
import { CreateLedgerAccountDto } from './dto/create-ledger-account.dto.js';
import { UpdateLedgerAccountDto } from './dto/update-ledger-account.dto.js';

/** Leaves `balance` out unless the user has balances:view. */
function withoutBalance(account: LedgerAccountDocument, user: AuthenticatedUser) {
  if (hasPermission(user, Permission.BALANCES_VIEW)) return account;
  const { balance: _balance, ...rest } = account.toJSON() as unknown as Record<string, unknown>;
  return rest;
}

/** Reads are open to any logged-in user (balances need balances:view); writes need accounts:manage. */
@Controller('accounts')
@UseGuards(JwtAuthGuard)
export class LedgerAccountController {
  constructor(private readonly ledgerAccountService: LedgerAccountService) {}

  @Get()
  async list(@Query() query: LedgerAccountQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const page = await this.ledgerAccountService.list(query);
    return { ...page, items: page.items.map((account) => withoutBalance(account, user)) };
  }

  // Declared before ':id' so "lookup" is not captured as an id.
  @Get('lookup')
  async lookup(@Query() query: LedgerAccountLookupQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const accounts = await this.ledgerAccountService.lookup(query);
    if (hasPermission(user, Permission.BALANCES_VIEW)) return accounts;
    return accounts.map(({ balance: _balance, ...account }) => account);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return withoutBalance(await this.ledgerAccountService.findById(id), user);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.ACCOUNTS_MANAGE)
  create(@Body() dto: CreateLedgerAccountDto) {
    return this.ledgerAccountService.create(dto);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.ACCOUNTS_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateLedgerAccountDto) {
    return this.ledgerAccountService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.ACCOUNTS_MANAGE)
  remove(@Param('id') id: string) {
    return this.ledgerAccountService.remove(id);
  }
}
