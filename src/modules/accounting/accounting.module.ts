import { Module } from '@nestjs/common';
import { LedgerAccountModule } from './ledger-accounts/ledger-account.module.js';
import { CashReceiptModule } from './cash-receipts/cash-receipt.module.js';

@Module({
  imports: [LedgerAccountModule, CashReceiptModule],
})
export class AccountingModule {}
