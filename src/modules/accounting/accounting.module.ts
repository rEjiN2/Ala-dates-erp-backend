import { Module } from '@nestjs/common';
import { LedgerAccountModule } from './ledger-accounts/ledger-account.module.js';
import { CashReceiptModule } from './cash-receipts/cash-receipt.module.js';
import { CashPaymentModule } from './cash-payments/cash-payment.module.js';
import { CashHandoverModule } from './cash-handovers/cash-handover.module.js';
import { ChequeModule } from './cheques/cheque.module.js';
import { OpeningBalanceModule } from './opening-balances/opening-balance.module.js';
import { AllocationModule } from './allocations/allocation.module.js';

@Module({
  imports: [
    LedgerAccountModule,
    CashReceiptModule,
    CashPaymentModule,
    CashHandoverModule,
    ChequeModule,
    OpeningBalanceModule,
    AllocationModule,
  ],
})
export class AccountingModule {}
