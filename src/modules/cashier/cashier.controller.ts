import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { Permission } from '../roles/permissions.js';
import { CashierService } from './cashier.service.js';
import { CashierLookupQueryDto, CashierQueryDto, CreateCashierDto, UpdateCashierDto } from './dto/cashier.dto.js';

@Controller('cashiers')
@UseGuards(JwtAuthGuard)
export class CashierController {
  constructor(private readonly cashierService: CashierService) {}

  @Get()
  list(@Query() query: CashierQueryDto) {
    return this.cashierService.list(query);
  }

  @Get('lookup')
  lookup(@Query() query: CashierLookupQueryDto) {
    return this.cashierService.lookup(query);
  }

  /** The cashier linked to the caller, or JSON null (Nest would otherwise send an empty body). */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser, @Res() res: Response) {
    res.json(await this.cashierService.findByLinkedUser(user.id));
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.cashierService.findById(id);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.CASHIERS_MANAGE)
  create(@Body() dto: CreateCashierDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashierService.create(dto, user);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.CASHIERS_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateCashierDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashierService.update(id, dto, user);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.CASHIERS_MANAGE)
  remove(@Param('id') id: string) {
    return this.cashierService.remove(id);
  }
}
