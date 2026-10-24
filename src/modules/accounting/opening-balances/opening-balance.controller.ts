import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { OpeningBalanceService } from './opening-balance.service.js';
import {
  CancelOpeningBalanceDto,
  CreateOpeningBalanceDto,
  OpeningBalanceQueryDto,
  UpdateOpeningBalanceDto,
  ValidateOpeningBalanceDto,
} from './dto/opening-balance.dto.js';

/** Every route needs an opening-balances permission; the actor always comes from the token. */
@Controller('opening-balances')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OpeningBalanceController {
  constructor(private readonly openingBalanceService: OpeningBalanceService) {}

  @Get()
  @RequirePermission(Permission.OPENING_BALANCES_READ)
  findAll(@Query() query: OpeningBalanceQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.openingBalanceService.findAll(query, user);
  }

  /** Lines by account code, resolved, with per-row errors. Posts nothing. */
  @Post('validate')
  @RequirePermission(Permission.OPENING_BALANCES_CREATE)
  validate(@Body() dto: ValidateOpeningBalanceDto) {
    return this.openingBalanceService.validate(dto);
  }

  @Get(':id')
  @RequirePermission(Permission.OPENING_BALANCES_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.openingBalanceService.findById(id, user);
  }

  @Post()
  @RequirePermission(Permission.OPENING_BALANCES_CREATE)
  create(@Body() dto: CreateOpeningBalanceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.openingBalanceService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission(Permission.OPENING_BALANCES_EDIT)
  update(@Param('id') id: string, @Body() dto: UpdateOpeningBalanceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.openingBalanceService.update(id, dto, user);
  }

  @Post(':id/cancel')
  @RequirePermission(Permission.OPENING_BALANCES_CANCEL)
  cancel(@Param('id') id: string, @Body() dto: CancelOpeningBalanceDto, @CurrentUser() user: AuthenticatedUser) {
    return this.openingBalanceService.cancel(id, dto, user);
  }
}
