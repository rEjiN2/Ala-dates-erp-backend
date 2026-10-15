import { Module } from '@nestjs/common';
import { LedgerAccountModule } from '../accounting/ledger-accounts/ledger-account.module.js';
import { DashboardService } from './dashboard.service.js';
import { DashboardController } from './dashboard.controller.js';

@Module({
  imports: [LedgerAccountModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
