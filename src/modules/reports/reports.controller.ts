import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { Permission } from '../roles/permissions.js';
import { AccountingReportsService } from './accounting-reports.service.js';
import { SalesmanCollectionsService } from './salesman-collections.service.js';
import { CashBookQueryDto, DayBookQueryDto, LedgerReportQueryDto, TrialBalanceQueryDto } from './dto/accounting-reports.dto.js';
import { SalesmanCollectionDetailsQueryDto, SalesmanCollectionsQueryDto } from './dto/salesman-collections.dto.js';

/** reports:salesman; "own"-scoped users see only their own row. */
@Controller('reports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReportsController {
  constructor(
    private readonly salesmanCollections: SalesmanCollectionsService,
    private readonly accounting: AccountingReportsService,
  ) {}

  /** Accounting reports (reports:accounting); ?format=csv|pdf downloads the whole report. */
  @Get('ledger')
  @RequirePermission(Permission.REPORTS_ACCOUNTING)
  ledger(@Query() query: LedgerReportQueryDto) {
    return this.accounting.ledger(query);
  }

  @Get('day-book')
  @RequirePermission(Permission.REPORTS_ACCOUNTING)
  dayBook(@Query() query: DayBookQueryDto) {
    return this.accounting.dayBook(query);
  }

  @Get('cash-book')
  @RequirePermission(Permission.REPORTS_ACCOUNTING)
  cashBook(@Query() query: CashBookQueryDto) {
    return this.accounting.cashBook(query);
  }

  @Get('trial-balance')
  @RequirePermission(Permission.REPORTS_ACCOUNTING)
  trialBalance(@Query() query: TrialBalanceQueryDto) {
    return this.accounting.trialBalance(query);
  }

  @Get('salesman-collections')
  @RequirePermission(Permission.REPORTS_SALESMAN)
  salesmanCollectionsReport(@Query() query: SalesmanCollectionsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesmanCollections.report(query, user);
  }

  /** The receipts and handovers behind one user's row. */
  @Get('salesman-collections/:staffId')
  @RequirePermission(Permission.REPORTS_SALESMAN)
  salesmanCollectionDetails(
    @Param('staffId') staffId: string,
    @Query() query: SalesmanCollectionDetailsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesmanCollections.details(staffId, query, user);
  }
}
