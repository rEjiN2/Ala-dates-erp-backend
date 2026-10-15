import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { Model, Types } from 'mongoose';
import { CashReceiptService } from './cash-receipt.service.js';
import { CashReceipt, CashReceiptDocument, CashReceiptSchema } from './schemas/cash-receipt.schema.js';
import {
  LedgerAccount,
  LedgerAccountDocument,
  LedgerAccountSchema,
  LedgerAccountStatus,
  LedgerAccountType,
} from '../ledger-accounts/schemas/ledger-account.schema.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../ledger-accounts/ledger-account-usage.registry.js';
import { LocationService } from '../../location/location.service.js';
import { Location, LocationSchema } from '../../location/schemas/location.schema.js';
import { Counter, CounterDocument, CounterSchema } from '../../sequence/schemas/counter.schema.js';
import { SequenceService } from '../../sequence/sequence.service.js';

describe('CashReceiptService (transactional)', () => {
  let moduleRef: TestingModule;
  let service: CashReceiptService;
  let ledgerAccountModel: Model<LedgerAccountDocument>;
  let cashReceiptModel: Model<CashReceiptDocument>;
  let counterModel: Model<CounterDocument>;

  beforeAll(async () => {
    // Providers are wired directly rather than importing CashReceiptModule:
    // this exercises the service against a real database without dragging the
    // controllers (and their auth guards) into the test.
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('cash_receipts'),
        MongooseModule.forFeature([
          { name: CashReceipt.name, schema: CashReceiptSchema },
          { name: LedgerAccount.name, schema: LedgerAccountSchema },
          { name: Counter.name, schema: CounterSchema },
          { name: Location.name, schema: LocationSchema },
        ]),
      ],
      providers: [
        CashReceiptService,
        LedgerAccountService,
        LedgerAccountUsageRegistry,
        LocationService,
        SequenceService,
      ],
    }).compile();

    service = moduleRef.get(CashReceiptService);
    ledgerAccountModel = moduleRef.get(getModelToken(LedgerAccount.name));
    cashReceiptModel = moduleRef.get(getModelToken(CashReceipt.name));
    counterModel = moduleRef.get(getModelToken(Counter.name));
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await cashReceiptModel.deleteMany({}).exec();
    await ledgerAccountModel.deleteMany({}).exec();
    await counterModel.deleteMany({}).exec();
  });

  async function makeAccount(
    code: string,
    type: LedgerAccountType,
    balance = 0,
  ): Promise<LedgerAccountDocument> {
    return ledgerAccountModel.create({
      code,
      name: `${code} account`,
      type,
      balance,
      status: LedgerAccountStatus.ACTIVE,
    });
  }

  async function balanceOf(account: LedgerAccountDocument): Promise<number> {
    const fresh = await ledgerAccountModel.findById(account._id).exec();
    return fresh!.balance;
  }

  it('posts a receipt and moves both sides of the balance', async () => {
    const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 1000);
    const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 500);

    const receipt = await service.create({
      voucherDate: '2026-09-21',
      cashAccountId: cash._id.toString(),
      cashier: 'Sachin',
      lines: [{ accountId: party._id.toString(), amount: 100, vat: 5, narration: 'Part payment' }],
    });

    expect(receipt.voucherNo).toBe('CR000001');
    expect(receipt.grossTotal).toBe(100);
    expect(receipt.totalTax).toBe(5);
    expect(receipt.grandTotal).toBe(105);
    expect(receipt.lines[0].netAmount).toBe(105);
    expect(receipt.lines[0].oldBalance).toBe(500);

    expect(await balanceOf(cash)).toBe(1105);
    expect(await balanceOf(party)).toBe(395);
  });

  it('rolls back everything when a later line has an unknown account', async () => {
    const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 1000);
    const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 500);
    const missingAccountId = new Types.ObjectId().toString();

    await expect(
      service.create({
        voucherDate: '2026-09-21',
        cashAccountId: cash._id.toString(),
        lines: [
          { accountId: party._id.toString(), amount: 100, vat: 0 },
          { accountId: missingAccountId, amount: 250, vat: 0 },
        ],
      }),
    ).rejects.toThrow(/not found/i);

    // Nothing persisted: no voucher, and both balances untouched.
    expect(await cashReceiptModel.countDocuments().exec()).toBe(0);
    expect(await balanceOf(cash)).toBe(1000);
    expect(await balanceOf(party)).toBe(500);
  });

  it('does not consume a voucher number when the transaction aborts', async () => {
    const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0);
    const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0);

    await expect(
      service.create({
        voucherDate: '2026-09-21',
        cashAccountId: cash._id.toString(),
        lines: [{ accountId: new Types.ObjectId().toString(), amount: 10 }],
      }),
    ).rejects.toThrow();

    const afterFailure = await service.create({
      voucherDate: '2026-09-21',
      cashAccountId: cash._id.toString(),
      lines: [{ accountId: party._id.toString(), amount: 10 }],
    });

    expect(afterFailure.voucherNo).toBe('CR000001');
  });

  it('gives concurrent receipts unique, gapless voucher numbers', async () => {
    const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0);
    const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0);

    const receipts = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.create({
          voucherDate: '2026-09-21',
          cashAccountId: cash._id.toString(),
          lines: [{ accountId: party._id.toString(), amount: 1 }],
        }),
      ),
    );

    expect(receipts.map((receipt) => receipt.voucherNo).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `CR${(i + 1).toString().padStart(6, '0')}`),
    );
    expect(await balanceOf(cash)).toBe(10);
  });

  it('rejects posting to an account that is not of type cash', async () => {
    const notCash = await makeAccount('BANK-001', LedgerAccountType.BANK, 0);
    const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0);

    await expect(
      service.create({
        voucherDate: '2026-09-21',
        cashAccountId: notCash._id.toString(),
        lines: [{ accountId: party._id.toString(), amount: 10 }],
      }),
    ).rejects.toThrow(/must post to a "cash" account/);

    expect(await cashReceiptModel.countDocuments().exec()).toBe(0);
  });

  it('reverses the old posting and applies the new one on update', async () => {
    const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0);
    const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0);

    const receipt = await service.create({
      voucherDate: '2026-09-21',
      cashAccountId: cash._id.toString(),
      lines: [{ accountId: party._id.toString(), amount: 100 }],
    });

    await service.update(receipt._id.toString(), {
      lines: [{ accountId: party._id.toString(), amount: 250 }],
    });

    expect(await balanceOf(cash)).toBe(250);
    expect(await balanceOf(party)).toBe(-250);
  });

  it('reverses balances when a receipt is deleted', async () => {
    const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 1000);
    const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 500);

    const receipt = await service.create({
      voucherDate: '2026-09-21',
      cashAccountId: cash._id.toString(),
      lines: [{ accountId: party._id.toString(), amount: 100, vat: 5 }],
    });

    await service.remove(receipt._id.toString());

    expect(await cashReceiptModel.countDocuments().exec()).toBe(0);
    expect(await balanceOf(cash)).toBe(1000);
    expect(await balanceOf(party)).toBe(500);
  });

  it('computes totals from the lines and ignores any client-sent totals', async () => {
    const cash = await makeAccount('CASH-001', LedgerAccountType.CASH, 0);
    const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0);

    const receipt = await service.create({
      voucherDate: '2026-09-21',
      cashAccountId: cash._id.toString(),
      // grandTotal/netAmount are not part of the DTO at all — the API surface
      // gives the client no way to send one.
      lines: [
        { accountId: party._id.toString(), amount: 33.33, vat: 1.67 },
        { accountId: party._id.toString(), amount: 10.1, vat: 0.9 },
      ],
    } as never);

    expect(receipt.grossTotal).toBe(43.43);
    expect(receipt.totalTax).toBe(2.57);
    expect(receipt.grandTotal).toBe(46);
    expect(await balanceOf(cash)).toBe(46);
    expect(await balanceOf(party)).toBe(-46);
  });

  it('filters by date range and cash account', async () => {
    const cashA = await makeAccount('CASH-001', LedgerAccountType.CASH, 0);
    const cashB = await makeAccount('CASH-002', LedgerAccountType.CASH, 0);
    const party = await makeAccount('PARTY-001', LedgerAccountType.PARTY, 0);

    await service.create({
      voucherDate: '2026-09-10',
      cashAccountId: cashA._id.toString(),
      lines: [{ accountId: party._id.toString(), amount: 10 }],
    });
    await service.create({
      voucherDate: '2026-09-20',
      cashAccountId: cashA._id.toString(),
      lines: [{ accountId: party._id.toString(), amount: 20 }],
    });
    await service.create({
      voucherDate: '2026-09-20',
      cashAccountId: cashB._id.toString(),
      lines: [{ accountId: party._id.toString(), amount: 30 }],
    });

    const byDate = await service.findAll({ dateFrom: '2026-09-15', dateTo: '2026-09-20' });
    expect(byDate).toHaveLength(2);

    const byDateAndAccount = await service.findAll({
      dateFrom: '2026-09-15',
      dateTo: '2026-09-20',
      cashAccountId: cashA._id.toString(),
    });
    expect(byDateAndAccount).toHaveLength(1);
    expect(byDateAndAccount[0].grandTotal).toBe(20);
  });
});
