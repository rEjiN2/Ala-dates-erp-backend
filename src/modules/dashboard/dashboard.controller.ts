import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { InvoiceTotalsService } from './invoice-totals.service.js';
import { DashboardRangeDto } from './dto/dashboard-range.dto.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { Permission } from '../roles/permissions.js';
import { DashboardService } from './dashboard.service.js';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly invoiceTotals: InvoiceTotalsService,
  ) {}

  /** Exposes every party/supplier balance in one call, so it needs more than a login. */
  @Get('summary')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.DASHBOARD_VIEW)
  getSummary() {
    return this.dashboardService.getSummary();
  }

  /** Daily net sales and per salesman; "own"-scoped users get their own. */
  @Get('sales')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.SALES_INVOICES_READ)
  getSales(@Query() range: DashboardRangeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.invoiceTotals.sales(range, user);
  }

  /** Daily net purchases; "own"-scoped users get their locations' only. */
  @Get('purchases')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.PURCHASE_INVOICES_READ)
  getPurchases(@Query() range: DashboardRangeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.invoiceTotals.purchases(range, user);
  }
}
