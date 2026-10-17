import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { Permission } from '../roles/permissions.js';
import { SalesmanCollectionsService } from './salesman-collections.service.js';
import { SalesmanCollectionDetailsQueryDto, SalesmanCollectionsQueryDto } from './dto/salesman-collections.dto.js';

/** reports:salesman; "own"-scoped users see only their own cashier. */
@Controller('reports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReportsController {
  constructor(private readonly salesmanCollections: SalesmanCollectionsService) {}

  @Get('salesman-collections')
  @RequirePermission(Permission.REPORTS_SALESMAN)
  salesmanCollectionsReport(@Query() query: SalesmanCollectionsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesmanCollections.report(query, user);
  }

  /** The receipts and handovers behind one cashier's row. */
  @Get('salesman-collections/:cashierId')
  @RequirePermission(Permission.REPORTS_SALESMAN)
  salesmanCollectionDetails(
    @Param('cashierId') cashierId: string,
    @Query() query: SalesmanCollectionDetailsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesmanCollections.details(cashierId, query, user);
  }
}
