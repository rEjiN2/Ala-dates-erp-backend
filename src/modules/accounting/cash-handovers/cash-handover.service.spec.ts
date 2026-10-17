import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import request from 'supertest';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../../test/voucher-test-module.js';
import { LedgerAccountType, type LedgerAccountDocument } from '../ledger-accounts/schemas/ledger-account.schema.js';
import type { CashierDocument } from '../../cashier/schemas/cashier.schema.js';
import { CashierStatus } from '../../cashier/schemas/cashier.schema.js';
import { User, type UserDocument } from '../../users/schemas/user.schema.js';
import { VoucherWarningsException } from '../vouchers/voucher-posting.service.js';
import { CreateCashHandoverDto } from './dto/cash-handover.dto.js';
import { CashHandoverController } from './cash-handover.controller.js';
import { createAppValidationPipe } from '../../../common/pipes/app-validation.pipe.js';
import { REQUIRE_PERMISSION_KEY } from '../../../common/decorators/require-permission.decorator.js';
import { DataScope, Permission, VAN_SALESMAN_PERMISSIONS } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

const { CASH, WALLET, BANK, PARTY } = LedgerAccountType;

describe('CashHandoverService', () => {
  let h: VoucherHarness;
  let userModel: Model<UserDocument>;
  const office = makeUser('Office');
  let van: CashierDocument;
  let desk: CashierDocument;
  let vanCash: LedgerAccountDocument;
  let officeCash: LedgerAccountDocument;
  let bank: LedgerAccountDocument;

  beforeAll(async () => {
    h = await createVoucherHarness('cash_handovers');
    userModel = h.moduleRef.get(getModelToken(User.name));
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  beforeEach(async () => {
    van = await h.cashiers.create({ name: 'Van 1' }, office);
    desk = await h.cashiers.create({ name: 'Office Desk' }, office);
    vanCash = await h.makeAccount('CASH-0001', CASH, 0, 'Van 1 Cash');
    officeCash = await h.makeAccount('CASH-0002', CASH, 0, 'Office Cash');
    bank = await h.makeAccount('BNK-0001', BANK, 0, 'ADCB');
  });

  afterEach(async () => {
    h.harness.tokenUser = makeUser('Sachin');
    await h.reset();
    await userModel.deleteMany({}).exec();
  });

  /** Puts cash in an account through a real receipt, so balances and entries agree. */
  async function collect(into: LedgerAccountDocument, amount: number, cashier = van, date = '2026-10-01') {
    const customer =
      (await h.models.account.findOne({ code: 'CUS-0001' }).exec()) ??
      (await h.makeAccount('CUS-0001', PARTY, 0, 'Ali Traders'));
    return h.receipts.create(
      {
        voucherDate: date,
        cashAccountId: into.id as string,
        cashierId: cashier.id as string,
        lines: [{ accountId: customer.id as string, amount }],
      },
      office,
    );
  }

  const handover = (extra: Partial<CreateCashHandoverDto> = {}, actor: AuthenticatedUser = office) =>
    h.handovers.create(
      {
        voucherDate: '2026-10-02',
        fromAccountId: vanCash.id as string,
        toAccountId: officeCash.id as string,
        amount: 100,
        handedByCashierId: van.id as string,
        receivedByCashierId: desk.id as string,
        ...extra,
      },
      actor,
    );

  /** Every account's balance equals the sum of its ledger entries. */
  async function expectReconciled() {
    const accounts = await h.models.account.find().lean().exec();
    for (const account of accounts) {
      const entries = (await h.models.entry.find({ accountId: account._id }).lean().exec()) as unknown as {
        debit: number;
        credit: number;
      }[];
      const net = Math.round(entries.reduce((sum, entry) => sum + entry.debit - entry.credit, 0) * 100) / 100;
      expect([account.code, account.balance]).toEqual([account.code, net]);
    }
  }

  describe('posting', () => {
    it('numbers CH-0001, debits the to account, credits the from account and audits', async () => {
      await collect(vanCash, 300);
      const created = await handover({ reference: 'Bag 12', notes: 'Evening drop' });

      expect(created.voucherNo).toBe('CH-0001');
      expect(created.toJSON()).toMatchObject({
        handedByCashierId: van._id,
        handedByCashierName: 'Van 1',
        receivedByCashierName: 'Office Desk',
        toAccountId: officeCash._id,
        amount: 100,
        paymentReference: 'Bag 12',
        comments: 'Evening drop',
      });
      expect(await h.balanceOf(vanCash)).toBe(200);
      expect(await h.balanceOf(officeCash)).toBe(100);
      const entries = (await h.models.entry.find({ voucherId: created._id }).lean().exec()) as unknown as {
        accountId: Types.ObjectId;
        debit: number;
        credit: number;
      }[];
      expect(entries.map((entry) => [entry.accountId.toString(), entry.debit, entry.credit])).toEqual(
        expect.arrayContaining([
          [vanCash.id, 0, 100],
          [officeCash.id, 100, 0],
        ]),
      );
      expect((await h.audit.findForEntity('cash-handover', created._id)).map((entry) => entry.action)).toEqual([
        'created',
      ]);
      expect((await handover({ amount: 1 })).voucherNo).toBe('CH-0002');
      await expectReconciled();
    });

    it('validates accounts, cashiers and the amount', async () => {
      const pipe = createAppValidationPipe();
      const base = {
        voucherDate: '2026-10-02',
        fromAccountId: vanCash.id,
        toAccountId: officeCash.id,
        handedByCashierId: van.id,
        receivedByCashierId: desk.id,
      };
      for (const body of [
        { ...base, amount: 0 },
        { ...base, amount: 1.005 },
        { ...base, amount: 5, receivedByCashierId: undefined },
        { ...base, amount: 5, voucherNo: 'CH-9999' },
      ]) {
        await expect(pipe.transform(body, { type: 'body', metatype: CreateCashHandoverDto })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }

      await expect(handover({ toAccountId: vanCash.id as string })).rejects.toThrow(/must be different/);
      await expect(handover({ receivedByCashierId: van.id as string })).rejects.toThrow(/must be different/);
      await expect(handover({ handedByCashierId: undefined })).rejects.toThrow('handedByCashierId is required');
      const customer = await h.makeAccount('CUS-0009', PARTY, 0, 'Not money');
      await expect(handover({ toAccountId: customer.id as string })).rejects.toThrow(/Choose a cash, wallet or bank/);
      await expect(handover({ fromAccountId: customer.id as string })).rejects.toThrow(/Choose a cash, wallet or bank/);
      await h.cashiers.update(desk.id as string, { status: CashierStatus.INACTIVE }, office);
      await expect(handover()).rejects.toThrow(/is inactive/);
      expect(await h.models.handover.countDocuments().exec()).toBe(0);
    });

    it('warns before taking a cash or wallet from account below zero; bank is exempt', async () => {
      await collect(vanCash, 50);
      const attempt = handover({ amount: 80 });
      await expect(attempt).rejects.toBeInstanceOf(VoucherWarningsException);
      await expect(handover({ amount: 80 })).rejects.toMatchObject({
        warnings: [{ code: 'NEGATIVE_BALANCE', accountCode: 'CASH-0001', balanceBefore: 50, balanceAfter: -30 }],
      });
      expect(await h.models.handover.countDocuments().exec()).toBe(0);
      expect(await h.balanceOf(vanCash)).toBe(50);

      await expect(handover({ amount: 80, acknowledgeWarnings: true })).resolves.toMatchObject({ grandTotal: 80 });
      const wallet = await h.makeAccount('WAL-0001', WALLET, 0, 'Van Wallet');
      await expect(handover({ fromAccountId: wallet.id as string, amount: 1 })).rejects.toBeInstanceOf(
        VoucherWarningsException,
      );
      await expect(handover({ fromAccountId: bank.id as string, amount: 1 })).resolves.toBeDefined();
      await expectReconciled();
    });
  });

  describe('edit and cancel', () => {
    it('edits by reversal with readable changes, rejects a no-op, and cancels with a reason', async () => {
      await collect(vanCash, 500);
      const created = await handover();
      const other = await h.cashiers.create({ name: 'Accounts' }, office);

      await h.handovers.update(
        created.id as string,
        { amount: 150, toAccountId: bank.id as string, receivedByCashierId: other.id as string, changeNote: 'Banked' },
        office,
      );
      expect(await h.balanceOf(vanCash)).toBe(350);
      expect(await h.balanceOf(officeCash)).toBe(0);
      expect(await h.balanceOf(bank)).toBe(150);
      await expect(h.handovers.update(created.id as string, { amount: 150 }, office)).rejects.toThrow(
        'No changes to save',
      );

      const [updated] = (await h.audit.findForEntity('cash-handover', created._id)).filter(
        (entry) => entry.action === 'updated',
      );
      expect(updated.reason).toBe('Banked');
      expect(updated.changes).toEqual(
        expect.arrayContaining([
          { field: 'receivedByCashier', label: 'Received by', from: 'Office Desk', to: 'Accounts' },
          { field: 'grandTotal', label: 'Total', from: 100, to: 150 },
        ]),
      );

      const cancelled = await h.handovers.cancel(created.id as string, { reason: 'Wrong bag' }, office);
      expect(cancelled.status).toBe('cancelled');
      expect(await h.balanceOf(vanCash)).toBe(500);
      expect(await h.balanceOf(bank)).toBe(0);
      await expect(h.handovers.update(created.id as string, { amount: 1 }, office)).rejects.toThrow(/cancelled/);
      await expectReconciled();
    });

    it('labels the handing-over cashier "Handed by" in the audit', async () => {
      await collect(vanCash, 500);
      const created = await handover();
      const other = await h.cashiers.create({ name: 'Van 2' }, office);
      await h.handovers.update(created.id as string, { handedByCashierId: other.id as string }, office);
      const [updated] = (await h.audit.findForEntity('cash-handover', created._id)).filter(
        (entry) => entry.action === 'updated',
      );
      expect(updated.changes).toEqual([{ field: 'cashier', label: 'Handed by', from: 'Van 1', to: 'Van 2' }]);
    });
  });

  describe('list, PDF and access', () => {
    it('lists with handover field names and filters by receiver', async () => {
      await collect(vanCash, 500);
      await handover({ amount: 40 });
      const other = await h.cashiers.create({ name: 'Accounts' }, office);
      await handover({ amount: 60, receivedByCashierId: other.id as string });

      const page = await h.handovers.findAll({ receivedByCashierId: other.id as string });
      expect(page.summary).toEqual({ count: 1, total: 60 });
      expect(page.items[0]).toMatchObject({
        voucherNo: 'CH-0002',
        fromAccount: { id: vanCash.id, name: 'Van 1 Cash' },
        toAccount: { id: officeCash.id, name: 'Office Cash' },
        handedBy: { id: van.id, name: 'Van 1' },
        receivedBy: { id: other.id, name: 'Accounts' },
        amount: 60,
      });
      expect((await h.handovers.findAll({ handedByCashierId: desk.id as string })).summary.count).toBe(0);
    });

    it('prints CASH HANDOVER VOUCHER with handed-by and received-by signatures', async () => {
      await collect(vanCash, 500);
      const created = await handover();
      const printed = await h.handovers.print(created.id as string, office);
      expect(printed.buffer.subarray(0, 4).toString()).toBe('%PDF');
      const text = JSON.stringify(printed.definition.content);
      for (const expected of ['CASH HANDOVER VOUCHER', 'Handed By', 'Received By', 'Office Desk', 'To Account']) {
        expect(text).toContain(expected);
      }
    });

    it('guards each route with its own permission; Van Salesman can only read', async () => {
      for (const [method, permission] of [
        ['findAll', Permission.CASH_HANDOVERS_READ],
        ['findOne', Permission.CASH_HANDOVERS_READ],
        ['pdf', Permission.CASH_HANDOVERS_READ],
        ['create', Permission.CASH_HANDOVERS_CREATE],
        ['update', Permission.CASH_HANDOVERS_EDIT],
        ['cancel', Permission.CASH_HANDOVERS_CANCEL],
      ] as const) {
        expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, CashHandoverController.prototype[method])).toEqual([
          permission,
        ]);
      }
      expect(VAN_SALESMAN_PERMISSIONS).toContain(Permission.CASH_HANDOVERS_READ);
      for (const write of [
        Permission.CASH_HANDOVERS_CREATE,
        Permission.CASH_HANDOVERS_EDIT,
        Permission.CASH_HANDOVERS_CANCEL,
      ]) {
        expect(VAN_SALESMAN_PERMISSIONS).not.toContain(write);
      }
    });

    it('shows a scoped user only handovers their cashier handed over, even ones they did not enter', async () => {
      const user = await userModel.create({
        email: 'rashid@ala.ae',
        passwordHash: 'x',
        name: 'Rashid',
        role: new Types.ObjectId(),
      });
      await h.cashiers.update(van.id as string, { linkedUserId: user.id as string }, office);
      const salesman: AuthenticatedUser = {
        ...makeUser('Rashid', [...VAN_SALESMAN_PERMISSIONS]),
        id: user.id as string,
        dataScope: DataScope.OWN,
        allowedCashAccountIds: [vanCash.id as string],
      };
      await collect(vanCash, 500);
      await collect(officeCash, 500, desk);
      const mine = await handover();
      // Received by his cashier, handed by another: not his.
      const toHim = await handover({
        fromAccountId: officeCash.id as string,
        toAccountId: vanCash.id as string,
        handedByCashierId: desk.id as string,
        receivedByCashierId: van.id as string,
      });

      h.harness.tokenUser = salesman;
      const server = h.app.getHttpServer();
      const list = await request(server).get('/cash-handovers');
      expect(list.status).toBe(200);
      expect(list.body.items.map((row: { id: string }) => row.id)).toEqual([mine.id]);
      expect((await request(server).get(`/cash-handovers/${mine.id}`)).status).toBe(200);
      for (const path of [`/cash-handovers/${toHim.id}`, `/cash-handovers/${toHim.id}/pdf`]) {
        expect((await request(server).get(path)).status).toBe(404);
      }
      expect(
        (await request(server).get('/activity').query({ entityType: 'cash-handover', entityId: toHim.id })).status,
      ).toBe(404);
      expect((await request(server).post('/cash-handovers').send({})).status).toBe(403);
    });
  });
});
