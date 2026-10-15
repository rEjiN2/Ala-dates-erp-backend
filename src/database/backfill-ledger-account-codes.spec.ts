import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { mongooseTestRoot } from '../../test/mongo-test-db.js';
import { backfillLedgerAccountCodes } from './backfill-ledger-account-codes.js';
import {
  LedgerAccount,
  LedgerAccountDocument,
  LedgerAccountSchema,
  LedgerAccountType,
} from '../modules/accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { SequenceService } from '../modules/sequence/sequence.service.js';
import { Counter, CounterDocument, CounterSchema } from '../modules/sequence/schemas/counter.schema.js';

describe('backfillLedgerAccountCodes', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accountModel: Model<LedgerAccountDocument>;
  let counterModel: Model<CounterDocument>;
  let sequenceService: SequenceService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('backfill_ledger_account_codes'),
        MongooseModule.forFeature([
          { name: LedgerAccount.name, schema: LedgerAccountSchema },
          { name: Counter.name, schema: CounterSchema },
        ]),
      ],
      providers: [SequenceService],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    accountModel = moduleRef.get(getModelToken(LedgerAccount.name));
    counterModel = moduleRef.get(getModelToken(Counter.name));
    sequenceService = moduleRef.get(SequenceService);
    await Promise.all([accountModel.init(), counterModel.init()]);
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await accountModel.deleteMany({}).exec();
    await counterModel.deleteMany({}).exec();
  });

  function run() {
    return backfillLedgerAccountCodes({ connection, ledgerAccountModel: accountModel, sequenceService });
  }

  async function legacy(code: string, type: LedgerAccountType, balance = 0, name = code) {
    return accountModel.create({ code, name, type, balance });
  }

  it('recodes old-format accounts, keeps ids and balances, and stores the old code', async () => {
    const main = await legacy('CASH-001', LedgerAccountType.CASH, 1500.25, 'Main Cash Counter');
    const bank = await legacy('BANK-1', LedgerAccountType.BANK, -20);

    const result = await run();

    expect(result.recoded.map(({ from, to }) => [from, to])).toEqual([
      ['CASH-001', 'CASH-0001'],
      ['BANK-1', 'BNK-0001'],
    ]);
    expect(await accountModel.findById(main._id).lean().exec()).toMatchObject({
      code: 'CASH-0001',
      legacyCode: 'CASH-001',
      balance: 1500.25,
    });
    expect(await accountModel.findById(bank._id).lean().exec()).toMatchObject({ code: 'BNK-0001', balance: -20 });
  });

  it('keeps accounts already in the generated format and numbers new ones above them', async () => {
    await legacy('CASH-0007', LedgerAccountType.CASH);
    await legacy('PETTY', LedgerAccountType.CASH);

    const result = await run();

    expect(result.recoded.map(({ from, to }) => [from, to])).toEqual([['PETTY', 'CASH-0008']]);
    expect(await sequenceService.nextCode({ key: 'ledger-account:cash', prefix: 'CASH-', width: 4 })).toBe(
      'CASH-0009',
    );
  });

  it('leaves party and supplier codes untouched and is idempotent', async () => {
    await legacy('P-1', LedgerAccountType.PARTY);
    await legacy('SUP-9', LedgerAccountType.SUPPLIER);
    await legacy('RENT', LedgerAccountType.EXPENSE);

    expect((await run()).recoded).toHaveLength(1);
    expect((await run()).recoded).toHaveLength(0);
    expect((await accountModel.find().sort({ code: 1 }).lean().exec()).map((a) => a.code)).toEqual([
      'EXP-0001',
      'P-1',
      'SUP-9',
    ]);
  });

  it('reports names that collide case-insensitively within a type', async () => {
    // Data from before the unique name index existed: drop it to simulate that.
    await accountModel.collection.dropIndex('type_name_ci_unique');
    try {
      await accountModel.collection.insertMany([
        { code: 'C1', name: 'Main', type: LedgerAccountType.CASH, balance: 0, status: 'active' },
        { code: 'C2', name: 'MAIN ', type: LedgerAccountType.CASH, balance: 0, status: 'active' },
        { code: 'B1', name: 'main', type: LedgerAccountType.BANK, balance: 0, status: 'active' },
      ]);

      const result = await run();

      expect(result.duplicateNames).toEqual(['cash: main (C1, C2)']);
    } finally {
      await accountModel.deleteMany({}).exec();
      await accountModel.syncIndexes();
    }
  });
});
