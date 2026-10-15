import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { Permission } from '../roles/permissions.js';
import { DashboardService } from './dashboard.service.js';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /** Exposes every party/supplier balance in one call, so it needs more than a login. */
  @Get('summary')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.DASHBOARD_VIEW)
  getSummary() {
    return this.dashboardService.getSummary();
  }
}
