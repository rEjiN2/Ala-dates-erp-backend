import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { LedgerAccountService } from './ledger-account.service.js';
import { LedgerAccountController } from './ledger-account.controller.js';
import { LedgerAccountUsageRegistry } from './ledger-account-usage.registry.js';
import {
  LedgerAccount,
  LedgerAccountDocument,
  LedgerAccountSchema,
  LedgerAccountStatus,
  LedgerAccountType,
} from './schemas/ledger-account.schema.js';
import { CreateLedgerAccountDto } from './dto/create-ledger-account.dto.js';
import { UpdateLedgerAccountDto } from './dto/update-ledger-account.dto.js';
import { LedgerAccountLookupQueryDto } from './dto/ledger-account-query.dto.js';
import { CashReceiptService } from '../cash-receipts/cash-receipt.service.js';
import { CashReceipt, CashReceiptDocument, CashReceiptSchema } from '../cash-receipts/schemas/cash-receipt.schema.js';
import { LocationService } from '../../location/location.service.js';
import { Location, LocationDocument, LocationSchema, LocationType } from '../../location/schemas/location.schema.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { Counter, CounterDocument, CounterSchema } from '../../sequence/schemas/counter.schema.js';
import { ADMIN_PERMISSIONS, Permission } from '../../roles/permissions.js';
import { REQUIRE_PERMISSION_KEY } from '../../../common/decorators/require-permission.decorator.js';
import { createAppValidationPipe } from '../../../common/pipes/app-validation.pipe.js';

const { CASH, BANK, WALLET, PARTY, SUPPLIER, INCOME, EXPENSE, OTHER } = LedgerAccountType;

describe('Accounts master (LedgerAccountService)', () => {
  let moduleRef: TestingModule;
  let service: LedgerAccountService;
  let accountModel: Model<LedgerAccountDocument>;
  let receiptModel: Model<CashReceiptDocument>;
  let locationModel: Model<LocationDocument>;
  let counterModel: Model<CounterDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('ledger_accounts'),
        MongooseModule.forFeature([
          { name: LedgerAccount.name, schema: LedgerAccountSchema },
          { name: CashReceipt.name, schema: CashReceiptSchema },
          { name: Location.name, schema: LocationSchema },
          { name: Counter.name, schema: CounterSchema },
        ]),
      ],
      // CashReceiptService is included so its usage check registers, exactly as in the app.
      providers: [LedgerAccountService, LedgerAccountUsageRegistry, CashReceiptService, LocationService, SequenceService],
    }).compile();

    service = moduleRef.get(LedgerAccountService);
    accountModel = moduleRef.get(getModelToken(LedgerAccount.name));
    receiptModel = moduleRef.get(getModelToken(CashReceipt.name));
    locationModel = moduleRef.get(getModelToken(Location.name));
    counterModel = moduleRef.get(getModelToken(Counter.name));
    await Promise.all([accountModel.init(), receiptModel.init(), locationModel.init(), counterModel.init()]);
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await Promise.all([
      accountModel.deleteMany({}).exec(),
      receiptModel.deleteMany({}).exec(),
      locationModel.deleteMany({}).exec(),
      counterModel.deleteMany({}).exec(),
    ]);
  });

  function create(type: LedgerAccountType, name = `${type} account`, extra: Partial<CreateLedgerAccountDto> = {}) {
    return service.create({ name, type, ...extra });
  }

  /** Party/supplier accounts only ever arrive from the Parties module; simulate that with a raw insert. */
  function systemAccount(type: LedgerAccountType, code: string, balance = 0) {
    return accountModel.create({ code, name: `${code} name`, type, balance });
  }

  async function withBalance(account: LedgerAccountDocument, balance: number) {
    await accountModel.updateOne({ _id: account._id }, { $set: { balance } }).exec();
  }

  const pipe = createAppValidationPipe();

  describe('codes', () => {
    it('keeps a separate counter and prefix per type', async () => {
      const codes = [];
      for (const type of [CASH, CASH, BANK, WALLET, INCOME, EXPENSE, OTHER, BANK]) {
        codes.push((await create(type, `${type} ${codes.length}`)).code);
      }
      expect(codes).toEqual([
        'CASH-0001',
        'CASH-0002',
        'BNK-0001',
        'WAL-0001',
        'INC-0001',
        'EXP-0001',
        'OTH-0001',
        'BNK-0002',
      ]);
    });

    it('gives 20 parallel creates 20 unique, gapless codes', async () => {
      const created = await Promise.all(Array.from({ length: 20 }, (_, i) => create(CASH, `Till ${i}`)));
      expect(created.map((account) => account.code).sort()).toEqual(
        Array.from({ length: 20 }, (_, i) => `CASH-${(i + 1).toString().padStart(4, '0')}`),
      );
    });

    it('does not burn a number when the insert fails (duplicate name)', async () => {
      await create(CASH, 'Main');
      await expect(create(CASH, 'MAIN')).rejects.toBeInstanceOf(ConflictException);
      expect((await create(CASH, 'Other')).code).toBe('CASH-0002');
    });

    it('cannot change code or type after create, even via the model', async () => {
      const account = await create(CASH);
      await service.update(account.id, { code: 'HACK-1', type: BANK } as UpdateLedgerAccountDto);
      await accountModel.updateOne({ _id: account._id }, { $set: { code: 'X-1', type: BANK } }).exec();

      expect(await accountModel.findById(account._id).lean().exec()).toMatchObject({ code: 'CASH-0001', type: CASH });
    });
  });

  describe('request validation (global pipe)', () => {
    async function rejects(body: object, metatype: new () => object) {
      await expect(pipe.transform(body, { type: 'body', metatype })).rejects.toBeInstanceOf(BadRequestException);
    }

    it('rejects code, balance and any opening balance on create', async () => {
      await rejects({ name: 'A', type: CASH, code: 'CASH-9999' }, CreateLedgerAccountDto);
      await rejects({ name: 'A', type: CASH, balance: 100 }, CreateLedgerAccountDto);
      await rejects({ name: 'A', type: CASH, openingBalance: 100 }, CreateLedgerAccountDto);
    });

    it('rejects party and supplier as a create type', async () => {
      await rejects({ name: 'A', type: PARTY }, CreateLedgerAccountDto);
      await rejects({ name: 'A', type: SUPPLIER }, CreateLedgerAccountDto);
    });

    it('rejects type, balance and code on update', async () => {
      await rejects({ type: BANK }, UpdateLedgerAccountDto);
      await rejects({ balance: 5 }, UpdateLedgerAccountDto);
      await rejects({ code: 'CASH-0009' }, UpdateLedgerAccountDto);
    });

    it('rejects unknown and invalid bankDetails fields', async () => {
      await rejects({ name: 'A', type: BANK, bankDetails: { routing: '1' } }, CreateLedgerAccountDto);
      await rejects({ name: 'A', type: BANK, bankDetails: { commissionPercent: 150 } }, CreateLedgerAccountDto);
    });

    it('parses lookup types from a comma list', async () => {
      const parsed = (await pipe.transform(
        { types: 'cash, bank', q: 'main' },
        { type: 'query', metatype: LedgerAccountLookupQueryDto },
      )) as LedgerAccountLookupQueryDto;
      expect(parsed.types).toEqual([CASH, BANK]);
      await rejects({ types: 'cash,piggybank' }, LedgerAccountLookupQueryDto);
    });
  });

  describe('system-managed party/supplier accounts', () => {
    it('rejects create, update and delete through the service', async () => {
      const party = await systemAccount(PARTY, 'P-0001');
      const supplier = await systemAccount(SUPPLIER, 'S-0001');

      await expect(service.create({ name: 'X', type: PARTY })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.update(party.id, { name: 'Renamed' })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.update(supplier.id, { status: LedgerAccountStatus.INACTIVE })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.remove(party.id)).rejects.toThrow(/system-managed/);
      expect(await accountModel.countDocuments().exec()).toBe(2);
    });

    it('still appears in lists, flagged as system-managed', async () => {
      await systemAccount(PARTY, 'P-0001');
      await create(CASH);

      const page = await service.list({ page: 1, limit: 20 });
      const json = page.items.map((item) => item.toJSON() as { code: string; isSystemManaged: boolean });

      expect(json.map(({ code, isSystemManaged }) => [code, isSystemManaged])).toEqual([
        ['CASH-0001', false],
        ['P-0001', true],
      ]);
    });
  });

  describe('bankDetails (bank only)', () => {
    it('accepts bankDetails on a bank account, with an expense charge account', async () => {
      const charges = await create(EXPENSE, 'Bank charges');

      const bank = await create(BANK, 'Main bank', {
        bankDetails: {
          bankName: 'Al Rajhi',
          iban: 'sa0380000000608010167519',
          bankChargeAccountId: charges.id,
          commissionPercent: 1.75,
          isMerchantAccount: true,
        },
      });

      expect(bank.bankDetails).toMatchObject({
        bankName: 'Al Rajhi',
        iban: 'SA0380000000608010167519',
        commissionPercent: 1.75,
        isMerchantAccount: true,
      });
      expect(bank.bankDetails?.bankChargeAccountId?.toString()).toBe(charges.id);
    });

    it('rejects bankDetails on every non-bank type, on create and update', async () => {
      for (const type of [CASH, WALLET, INCOME, EXPENSE, OTHER]) {
        await expect(create(type, `${type} x`, { bankDetails: { bankName: 'X' } })).rejects.toThrow(
          /bankDetails are only allowed on bank accounts/,
        );
      }
      const cash = await create(CASH);
      await expect(service.update(cash.id, { bankDetails: { bankName: 'X' } })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a bank charge account that is not an expense account, or does not exist', async () => {
      const income = await create(INCOME);
      await expect(
        create(BANK, 'B1', { bankDetails: { bankChargeAccountId: income.id } }),
      ).rejects.toThrow(/must be an expense account/);
      await expect(
        create(BANK, 'B2', { bankDetails: { bankChargeAccountId: new Types.ObjectId().toString() } }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('clears bankDetails when updated to null', async () => {
      const bank = await create(BANK, 'B', { bankDetails: { bankName: 'X' } });
      const updated = await service.update(bank.id, { bankDetails: null });
      expect(updated.bankDetails).toBeNull();
    });
  });

  describe('locationId (cash only)', () => {
    it('accepts an existing location on a cash account', async () => {
      const location = await locationModel.create({ code: 'ST-0001', name: 'Store', type: LocationType.STORE });
      const cash = await create(CASH, 'Store till', { locationId: location.id });
      expect(cash.locationId?.toString()).toBe(location.id);
    });

    it('rejects an unknown location, and a location on a non-cash account', async () => {
      await expect(create(CASH, 'Till', { locationId: new Types.ObjectId().toString() })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const location = await locationModel.create({ code: 'ST-0001', name: 'Store', type: LocationType.STORE });
      await expect(create(BANK, 'Bank', { locationId: location.id })).rejects.toThrow(
        /locationId is only allowed on cash accounts/,
      );
    });
  });

  describe('name uniqueness', () => {
    it('is per type and case-insensitive', async () => {
      await create(CASH, 'Main Account');

      await expect(create(CASH, 'main account')).rejects.toThrow(
        new ConflictException('A cash account named "main account" already exists (names are case-insensitive)'),
      );
      await expect(create(BANK, 'MAIN ACCOUNT')).resolves.toBeDefined();
    });

    it('is enforced on rename too', async () => {
      await create(CASH, 'Till A');
      const other = await create(CASH, 'Till B');
      await expect(service.update(other.id, { name: 'TILL A' })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('delete', () => {
    it('rejects deleting an account with a non-zero balance, suggesting deactivation', async () => {
      const cash = await create(CASH);
      await withBalance(cash, 12.5);

      await expect(service.remove(cash.id)).rejects.toThrow(
        `Cannot delete CASH-0001 (cash account): its balance is 12.5, not 0. Deactivate it instead.`,
      );
      await expect(service.update(cash.id, { status: LedgerAccountStatus.INACTIVE })).resolves.toMatchObject({
        status: LedgerAccountStatus.INACTIVE,
      });
    });

    it('rejects deleting a zero-balance account a cash receipt refers to, on either side', async () => {
      const cash = await create(CASH);
      const income = await create(INCOME);
      await receiptModel.create({
        voucherNo: 'CR000001',
        voucherDate: new Date(),
        cashAccountId: cash._id,
        lines: [{ accountId: income._id, amount: 10, netAmount: 10 }],
      });

      expect(await service.isLedgerAccountUsed(cash.id)).toBe(true);
      expect(await service.isLedgerAccountUsed(income.id)).toBe(true);
      await expect(service.remove(cash.id)).rejects.toThrow(/used by cash receipts\. Deactivate it instead/);
      await expect(service.remove(income.id)).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects deleting an expense account a bank uses for charges', async () => {
      const charges = await create(EXPENSE);
      await create(BANK, 'B', { bankDetails: { bankChargeAccountId: charges.id } });

      await expect(service.remove(charges.id)).rejects.toThrow(/bank charge account/);
    });

    it('deletes an unused zero-balance account', async () => {
      const wallet = await create(WALLET);
      expect(await service.isLedgerAccountUsed(wallet.id)).toBe(false);

      await expect(service.remove(wallet.id)).resolves.toEqual({ success: true });
      expect(await accountModel.findById(wallet._id).exec()).toBeNull();
    });
  });

  describe('list and lookup', () => {
    async function seedMix() {
      await create(CASH, 'Main Cash');
      await create(CASH, 'Van Cash', { status: LedgerAccountStatus.INACTIVE });
      await create(BANK, 'Main Bank');
      await create(WALLET, 'STC Pay');
      await create(EXPENSE, 'Main Rent');
      await systemAccount(PARTY, 'P-0001');
    }

    it('lookup filters by types and q, returns only active accounts in the compact shape', async () => {
      await seedMix();

      const result = await service.lookup({ types: [CASH, BANK], q: 'main', limit: 50 });

      expect(result).toEqual([
        { id: expect.any(String), code: 'BNK-0001', name: 'Main Bank', type: BANK, balance: 0 },
        { id: expect.any(String), code: 'CASH-0001', name: 'Main Cash', type: CASH, balance: 0 },
      ]);
    });

    it('lookup without types spans all types but still excludes inactive accounts', async () => {
      await seedMix();
      const codes = (await service.lookup({ limit: 50 })).map((item) => item.code);
      expect(codes).toEqual(['BNK-0001', 'CASH-0001', 'EXP-0001', 'P-0001', 'WAL-0001']);
    });

    it('list supports search, type, status and pagination', async () => {
      await seedMix();

      const search = await service.list({ q: 'cash', page: 1, limit: 20 });
      expect(search.items.map((item) => item.name)).toEqual(['Main Cash', 'Van Cash']);

      const inactiveCash = await service.list({ type: CASH, status: LedgerAccountStatus.INACTIVE, page: 1, limit: 20 });
      expect(inactiveCash.items.map((item) => item.name)).toEqual(['Van Cash']);

      const page2 = await service.list({ page: 2, limit: 4 });
      expect(page2).toMatchObject({ total: 6, page: 2, limit: 4 });
      expect(page2.items).toHaveLength(2);
    });

    it('list search also matches a legacy code', async () => {
      const cash = await create(CASH, 'Old till');
      await accountModel.collection.updateOne({ _id: cash._id }, { $set: { legacyCode: 'CASH-001' } });
      expect((await service.list({ q: 'cash-001', page: 1, limit: 20 })).items.map((i) => i.code)).toEqual([
        'CASH-0001',
      ]);
    });
  });

  describe('permissions', () => {
    const reflector = new Reflector();
    const required = (handler: keyof LedgerAccountController) =>
      reflector.get<string[] | undefined>(REQUIRE_PERMISSION_KEY, LedgerAccountController.prototype[handler]);

    it('guards writes with accounts:manage and leaves reads open to logged-in users', () => {
      for (const handler of ['create', 'update', 'remove'] as const) {
        expect(required(handler)).toEqual([Permission.ACCOUNTS_MANAGE]);
      }
      for (const handler of ['list', 'lookup', 'findOne'] as const) {
        expect(required(handler)).toBeUndefined();
      }
    });

    it('grants accounts:manage to the admin role', () => {
      expect(ADMIN_PERMISSIONS).toContain('accounts:manage');
    });
  });
});
