import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { Permission } from '../../roles/permissions.js';
import { LedgerAccountService } from './ledger-account.service.js';
import { LedgerAccountLookupQueryDto, LedgerAccountQueryDto } from './dto/ledger-account-query.dto.js';
import { CreateLedgerAccountDto } from './dto/create-ledger-account.dto.js';
import { UpdateLedgerAccountDto } from './dto/update-ledger-account.dto.js';

/** Reads are open to any logged-in user; writes need accounts:manage. */
@Controller('accounts')
@UseGuards(JwtAuthGuard)
export class LedgerAccountController {
  constructor(private readonly ledgerAccountService: LedgerAccountService) {}

  @Get()
  list(@Query() query: LedgerAccountQueryDto) {
    return this.ledgerAccountService.list(query);
  }

  // Declared before ':id' so "lookup" is not captured as an id.
  @Get('lookup')
  lookup(@Query() query: LedgerAccountLookupQueryDto) {
    return this.ledgerAccountService.lookup(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ledgerAccountService.findById(id);
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
