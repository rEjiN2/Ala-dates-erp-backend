import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { OpeningStockService } from './opening-stock.service.js';
import {
  CancelOpeningStockDto,
  CreateOpeningStockDto,
  OpeningStockQueryDto,
  UpdateOpeningStockDto,
  ValidateOpeningStockDto,
} from './dto/opening-stock.dto.js';

/** Every route needs an opening-stock permission; the actor always comes from the token. */
@Controller('opening-stock')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OpeningStockController {
  constructor(private readonly openingStockService: OpeningStockService) {}

  @Get()
  @RequirePermission(Permission.OPENING_STOCK_READ)
  findAll(@Query() query: OpeningStockQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.openingStockService.findAll(query, user);
  }

  /** Lines by product code, resolved, with per-row errors. Posts nothing. */
  @Post('validate')
  @RequirePermission(Permission.OPENING_STOCK_CREATE)
  validate(@Body() dto: ValidateOpeningStockDto, @CurrentUser() user: AuthenticatedUser) {
    return this.openingStockService.validate(dto, user);
  }

  @Get(':id')
  @RequirePermission(Permission.OPENING_STOCK_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.openingStockService.findById(id, user);
  }

  @Post()
  @RequirePermission(Permission.OPENING_STOCK_CREATE)
  create(@Body() dto: CreateOpeningStockDto, @CurrentUser() user: AuthenticatedUser) {
    return this.openingStockService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission(Permission.OPENING_STOCK_EDIT)
  update(@Param('id') id: string, @Body() dto: UpdateOpeningStockDto, @CurrentUser() user: AuthenticatedUser) {
    return this.openingStockService.update(id, dto, user);
  }

  @Post(':id/cancel')
  @RequirePermission(Permission.OPENING_STOCK_CANCEL)
  cancel(@Param('id') id: string, @Body() dto: CancelOpeningStockDto, @CurrentUser() user: AuthenticatedUser) {
    return this.openingStockService.cancel(id, dto, user);
  }
}
