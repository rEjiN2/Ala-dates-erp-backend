import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { Permission } from '../roles/permissions.js';
import { StockService } from './stock.service.js';
import { StockHistoryQueryDto, StockSummaryQueryDto } from './dto/stock.dto.js';

/** "own"-scoped users see only their allowedLocationIds; another location is 403. */
@Controller('stock')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class StockController {
  constructor(private readonly stockService: StockService) {}

  @Get('summary')
  @RequirePermission(Permission.STOCK_READ)
  summary(@Query() query: StockSummaryQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockService.summary(query, user);
  }

  @Get('history')
  @RequirePermission(Permission.STOCK_READ)
  history(@Query() query: StockHistoryQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stockService.history(query, user);
  }
}
