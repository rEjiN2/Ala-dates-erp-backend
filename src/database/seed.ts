import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import {
  LedgerAccount,
  LedgerAccountDocument,
  LedgerAccountType,
  SYSTEM_ACCOUNTS,
} from '../modules/accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { LedgerAccountService } from '../modules/accounting/ledger-accounts/ledger-account.service.js';
import { Counter, CounterDocument } from '../modules/sequence/schemas/counter.schema.js';
import { Role, RoleDocument } from '../modules/roles/schemas/role.schema.js';
import { User, UserDocument } from '../modules/users/schemas/user.schema.js';
import { backfillUserStatus, ensureDefaultRoles } from './seed-roles.js';
import { CompanyService } from '../modules/company/company.service.js';
import {
  OPENING_BALANCE_EQUITY_KEY,
  OPENING_BALANCE_EQUITY_NAME,
} from '../modules/accounting/opening-balances/schemas/opening-balance.schema.js';
import {
  DEFAULT_UNITS,
  UNIT_COLLATION,
  Unit,
  UnitDocument,
} from '../modules/product/units/schemas/unit.schema.js';

import { CASH_CUSTOMER_KEY, Party, PartyDocument, PartyKind } from '../modules/party/schemas/party.schema.js';
import { PartyService } from '../modules/party/party.service.js';

const CASH_ACCOUNT_NAMES = ['Main Cash Counter', 'Branch Petty Cash'];
const CASH_CUSTOMER_NAME = 'Cash Customer';
/** Audit actor for records the seed creates. */
const SEED_ACTOR_ID = '000000000000000000000000';
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
    await counterModel
      .updateOne({ key: 'opening-stock' }, { $setOnInsert: { key: 'opening-stock', seq: 0 } }, { upsert: true })
      .exec();
    logger.log('Voucher counter ready: opening-stock');
    await counterModel
      .updateOne({ key: 'purchase-invoice' }, { $setOnInsert: { key: 'purchase-invoice', seq: 0 } }, { upsert: true })
      .exec();
    logger.log('Voucher counter ready: purchase-invoice');
    await counterModel
      .updateOne({ key: 'sales-invoice' }, { $setOnInsert: { key: 'sales-invoice', seq: 0 } }, { upsert: true })
      .exec();
    logger.log('Voucher counter ready: sales-invoice');
    for (const key of ['sales-return', 'purchase-return']) {
      await counterModel.updateOne({ key }, { $setOnInsert: { key, seq: 0 } }, { upsert: true }).exec();
      logger.log(`Voucher counter ready: ${key}`);
    }

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

    // System account that balances opening vouchers; never edited or chosen on a voucher.
    const equity = await ledgerAccountService.ensureSystemAccount(
      OPENING_BALANCE_EQUITY_KEY,
      OPENING_BALANCE_EQUITY_NAME,
      LedgerAccountType.OTHER,
    );
    logger.log(`Ledger account ready: ${equity.code} (${equity.name})`);

    // Purchases/VAT Input and Sales/VAT Output: posted by purchase and sales invoices only.
    for (const system of Object.values(SYSTEM_ACCOUNTS)) {
      const account = await ledgerAccountService.ensureSystemAccount(system.key, system.name, system.type);
      logger.log(`Ledger account ready: ${account.code} (${account.name})`);
    }

    // The walk-in customer: an existing customer of that name is adopted, else one is created.
    const partyModel = app.get<Model<PartyDocument>>(getModelToken(Party.name));
    let cashCustomer = await partyModel.findOne({ systemKey: CASH_CUSTOMER_KEY }).exec();
    if (!cashCustomer) {
      cashCustomer = await partyModel
        .findOne({ kind: PartyKind.CUSTOMER, name: CASH_CUSTOMER_NAME })
        .collation({ locale: 'en', strength: 2 })
        .exec();
      if (!cashCustomer) {
        const view = await app
          .get(PartyService)
          .create({ kind: PartyKind.CUSTOMER, name: CASH_CUSTOMER_NAME }, { id: SEED_ACTOR_ID, name: 'System' });
        cashCustomer = await partyModel.findById(view.id).exec();
      }
      await partyModel.updateOne({ _id: cashCustomer!._id }, { $set: { systemKey: CASH_CUSTOMER_KEY } }).exec();
    }
    logger.log(`Party ready: ${cashCustomer!.code} (${cashCustomer!.name})`);

    // Handover expense claims are paid from petty cash; an existing default is left as it is.
    if (!company.defaultPettyCashAccountId) {
      const pettyCash = await ledgerAccountModel
        .findOne({ type: LedgerAccountType.CASH, name: 'Branch Petty Cash' })
        .collation({ locale: 'en', strength: 2 })
        .exec();
      if (pettyCash) {
        company.defaultPettyCashAccountId = pettyCash._id;
        await company.save();
      }
    }

    // Default units, matched on symbol (ignoring case); existing ones are left as they are.
    const unitModel = app.get<Model<UnitDocument>>(getModelToken(Unit.name));
    for (const unit of DEFAULT_UNITS) {
      await unitModel
        .updateOne({ symbol: unit.symbol }, { $setOnInsert: unit }, { upsert: true, collation: UNIT_COLLATION })
        .exec();
    }
    logger.log(`Units ready: ${DEFAULT_UNITS.map((unit) => unit.symbol).join(', ')}`);

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
