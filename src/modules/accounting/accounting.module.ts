import { Module } from '@nestjs/common';
import { LedgerAccountModule } from './ledger-accounts/ledger-account.module.js';
import { CashReceiptModule } from './cash-receipts/cash-receipt.module.js';
import { CashPaymentModule } from './cash-payments/cash-payment.module.js';
import { CashHandoverModule } from './cash-handovers/cash-handover.module.js';
import { ChequeModule } from './cheques/cheque.module.js';

@Module({
  imports: [LedgerAccountModule, CashReceiptModule, CashPaymentModule, CashHandoverModule, ChequeModule],
})
export class AccountingModule {}
