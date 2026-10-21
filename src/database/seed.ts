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
import { User, UserDocument } from '../modules/users/schemas/user.schema.js';
import { backfillUserStatus, ensureDefaultRoles } from './seed-roles.js';
import { CompanyService } from '../modules/company/company.service.js';

const CASH_ACCOUNT_NAMES = ['Main Cash Counter', 'Branch Petty Cash'];
const CHEQUES_IN_HAND_NAME = 'Cheques in Hand';

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
    await counterModel
      .updateOne({ key: 'cash-payment' }, { $setOnInsert: { key: 'cash-payment', seq: 0 } }, { upsert: true })
      .exec();
    logger.log('Voucher counter ready: cash-payment');

    // Created with the defaults (ALA DATES LLC, Jurf 3, Ajman) only if missing;
    // an edited profile is left as it is.
    const company = await app.get(CompanyService).ensure();
    logger.log(`Company profile ready: ${company.legalName}`);

    // One company cheques-in-hand account, the default for cheques received
    // at the office; an existing default is left as it is.
    const cheques =
      (await ledgerAccountModel
        .findOne({ type: LedgerAccountType.CHEQUE, name: CHEQUES_IN_HAND_NAME })
        .collation({ locale: 'en', strength: 2 })
        .exec()) ??
      (await ledgerAccountService.create({ name: CHEQUES_IN_HAND_NAME, type: LedgerAccountType.CHEQUE }));
    if (!company.defaultChequesInHandAccountId) {
      company.defaultChequesInHandAccountId = cheques._id;
      await company.save();
    }
    logger.log(`Ledger account ready: ${cheques.code} (${cheques.name})`);

    // Splits legacy permissions (cash-receipts:manage, ...) in every role, then
    // upserts admin (every permission, scope all, protected), Accountant and
    // Van Salesman. Users must log in again only for the frontend's cached
    // copy: the API reads permissions from the database on every request.
    const roles = await ensureDefaultRoles(app.get<Model<RoleDocument>>(getModelToken(Role.name)));
    for (const role of roles) {
      logger.log(`Role ready: ${role.name} [${role.dataScope}] (${role.permissions.join(', ')})`);
    }

    const movedUsers = await backfillUserStatus(app.get<Model<UserDocument>>(getModelToken(User.name)));
    logger.log(`User status ready (${movedUsers} moved from isActive)`);
  } finally {
    await app.close();
  }
}

await seed();
