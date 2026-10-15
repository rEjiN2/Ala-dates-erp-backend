import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import {
  LedgerAccount,
  LedgerAccountDocument,
  LedgerAccountType,
} from '../modules/accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { LedgerAccountService } from '../modules/accounting/ledger-accounts/ledger-account.service.js';
import { Counter, CounterDocument } from '../modules/sequence/schemas/counter.schema.js';
import { Role, RoleDocument } from '../modules/roles/schemas/role.schema.js';
import { ensureAdminRole } from './seed-roles.js';

const CASH_ACCOUNT_NAMES = ['Main Cash Counter', 'Branch Petty Cash'];

async function seed(): Promise<void> {
  const logger = new Logger('Seed');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const ledgerAccountModel = app.get<Model<LedgerAccountDocument>>(getModelToken(LedgerAccount.name));
    const counterModel = app.get<Model<CounterDocument>>(getModelToken(Counter.name));

    const ledgerAccountService = app.get(LedgerAccountService);
    for (const name of CASH_ACCOUNT_NAMES) {
      // Keyed on (type, name), the account's natural unique key: codes are
      // generated, so a re-run finds the existing account and never touches
      // its balance.
      const existing = await ledgerAccountModel
        .findOne({ type: LedgerAccountType.CASH, name })
        .collation({ locale: 'en', strength: 2 })
        .exec();
      const account = existing ?? (await ledgerAccountService.create({ name, type: LedgerAccountType.CASH }));
      logger.log(`Ledger account ready: ${account.code} (${account.name})`);
    }

    // Pre-create the voucher counter so the first receipt does not have to
    // create the collection inside its transaction.
    await counterModel
      .updateOne({ key: 'cash-receipt' }, { $setOnInsert: { key: 'cash-receipt', seq: 0 } }, { upsert: true })
      .exec();
    logger.log('Voucher counter ready: cash-receipt');

    const adminRole = await ensureAdminRole(app.get<Model<RoleDocument>>(getModelToken(Role.name)));
    logger.log(`Role ready: ${adminRole.name} (${adminRole.permissions.join(', ')})`);
  } finally {
    await app.close();
  }
}

await seed();
