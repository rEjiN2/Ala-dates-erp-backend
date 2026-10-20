import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import request from 'supertest';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../../test/voucher-test-module.js';
import { LedgerAccountType, type LedgerAccountDocument } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { type CashierDocument, StaffType } from '../../cashier/schemas/cashier.schema.js';
import { User, type UserDocument } from '../../users/schemas/user.schema.js';
import type { CreateCashHandoverDto } from './dto/cash-handover.dto.js';
import { CashHandoverController } from './cash-handover.controller.js';
import { backfillHandoverApproval } from '../../../database/backfill-handover-approval.js';
import { REQUIRE_PERMISSION_KEY } from '../../../common/decorators/require-permission.decorator.js';
import { ACCOUNTANT_PERMISSIONS, DataScope, Permission, VAN_SALESMAN_PERMISSIONS } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

const { CASH, BANK, PARTY } = LedgerAccountType;

describe('CashHandoverService (approval)', () => {
  let h: VoucherHarness;
  let userModel: Model<UserDocument>;
  const office = makeUser('Office');
  const approver = makeUser('Approver');
  let van: CashierDocument;
  let vanCash: LedgerAccountDocument;
  let officeCash: LedgerAccountDocument;
  let bank: LedgerAccountDocument;
  let customer: LedgerAccountDocument;

  beforeAll(async () => {
    h = await createVoucherHarness('cash_handovers');
    userModel = h.moduleRef.get(getModelToken(User.name));
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  beforeEach(async () => {
    van = await h.cashiers.create({ name: 'Van 1', staffType: StaffType.VAN_SALESMAN }, office);
    vanCash = await h.makeAccount('CASH-0001', CASH, 0, 'Van 1 Cash');
    officeCash = await h.makeAccount('CASH-0002', CASH, 0, 'Office Cash');
    bank = await h.makeAccount('BNK-0001', BANK, 0, 'ADCB');
    customer = await h.makeAccount('CUS-0001', PARTY, 0, 'Ali Traders');
  });

  afterEach(async () => {
    h.harness.tokenUser = makeUser('Sachin');
    await h.reset();
    await userModel.deleteMany({}).exec();
  });

  const collect = (into: LedgerAccountDocument, amount: number, cashier = van, date = '2026-10-01') =>
    h.receipts.create(
      {
        voucherDate: date,
        cashAccountId: into.id as string,
        cashierId: cashier.id as string,
        lines: [{ accountId: customer.id as string, amount }],
      },
      office,
    );

  const submit = (receiptIds: string[], extra: Partial<CreateCashHandoverDto> = {}, actor: AuthenticatedUser = office) =>
    h.handovers.create(
      {
        voucherDate: '2026-10-02',
        staffId: van.id as string,
        sourceAccountId: vanCash.id as string,
        receiptIds,
        countedCash: 0,
        ...extra,
      },
      actor,
    );

  const approve = (id: string, receivedCash: number, varianceReason?: string, actor: AuthenticatedUser = approver) =>
    h.handovers.approve(id, { receivedCash, receivedIntoAccountId: officeCash.id as string, varianceReason }, actor);

  const statusOf = async (receiptId: string) =>
    (await h.models.receipt.findById(receiptId).lean().exec()) as unknown as {
      settlementStatus: string | null;
      handoverId: Types.ObjectId | null;
    };

  /** Every account's balance equals the sum of its ledger entries. */
  async function expectReconciled() {
    for (const account of await h.models.account.find().lean().exec()) {
      const entries = (await h.models.entry.find({ accountId: account._id }).lean().exec()) as unknown as {
        debit: number;
        credit: number;
      }[];
      const net = Math.round(entries.reduce((sum, entry) => sum + entry.debit - entry.credit, 0) * 100) / 100;
      expect([account.code, account.balance]).toEqual([account.code, net]);
    }
  }

  it('starts receipts of settling staff unsettled; others and cancelled ones have no status', async () => {
    const accountant = await h.cashiers.create({ name: 'Accounts', staffType: StaffType.ACCOUNTANT }, office);
    const vanReceipt = await collect(vanCash, 100);
    const deskReceipt = await collect(officeCash, 100, accountant);
    expect((await statusOf(vanReceipt.id as string)).settlementStatus).toBe('unsettled');
    expect((await statusOf(deskReceipt.id as string)).settlementStatus).toBeNull();
    await h.receipts.cancel(vanReceipt.id as string, { reason: 'Duplicate' }, office);
    expect((await statusOf(vanReceipt.id as string)).settlementStatus).toBeNull();
  });

  it('submit: numbers CH-0001, totals cash and bank, locks the receipts and posts nothing', async () => {
    const cash1 = await collect(vanCash, 300);
    const cash2 = await collect(vanCash, 200, van, '2026-10-02');
    const viaBank = await collect(bank, 150);
    const created = await submit([cash2.id, cash1.id, viaBank.id] as string[], { countedCash: 500, notes: 'Evening' });

    expect(created.voucherNo).toBe('CH-0001');
    expect(created.toJSON()).toMatchObject({
      status: 'submitted',
      staffName: 'Van 1',
      expectedCash: 500,
      bankTotal: 150,
      countedCash: 500,
      receivedCash: null,
      lines: [],
    });
    expect(created.receipts.map((receipt) => receipt.voucherNo)).toEqual([cash1.voucherNo, viaBank.voucherNo, cash2.voucherNo]);
    expect(await h.models.entry.countDocuments({ voucherId: created._id })).toBe(0);
    for (const receipt of [cash1, cash2, viaBank]) {
      expect(await statusOf(receipt.id as string)).toMatchObject({ settlementStatus: 'submitted', handoverId: created._id });
    }
    await expect(
      h.receipts.update(cash1.id as string, { comments: 'changed' }, office),
    ).rejects.toThrow(/submitted on a cash handover and cannot be edited/);
    await expect(h.receipts.cancel(cash1.id as string, { reason: 'Oops' }, office)).rejects.toThrow(/cannot be cancelled/);
    await expect(h.receipts.remove(cash1.id as string)).rejects.toThrow(/cannot be deleted/);
    // Already on a handover: can't be submitted again.
    await expect(submit([cash1.id as string])).rejects.toThrow(/not unsettled receipts/);
    expect((await h.audit.findForEntity('cash-handover', created._id)).map((entry) => entry.action)).toEqual(['created']);
  });

  it('submit refuses non-settling staff, other staff receipts and cash received elsewhere', async () => {
    const accountant = await h.cashiers.create({ name: 'Accounts', staffType: StaffType.ACCOUNTANT }, office);
    const theirs = await collect(officeCash, 100, accountant);
    const elsewhere = await collect(officeCash, 50);
    await expect(submit([theirs.id as string], { staffId: accountant.id as string })).rejects.toThrow(
      /does not settle cash with the office/,
    );
    await expect(submit([theirs.id as string])).rejects.toThrow(/not unsettled receipts of CSH-0001/);
    await expect(submit([elsewhere.id as string])).rejects.toThrow(/were not received into CASH-0001/);
    await expect(submit([elsewhere.id as string], { sourceAccountId: bank.id as string })).rejects.toThrow(
      /source must be a cash or wallet account/,
    );
    expect(await h.models.handover.countDocuments()).toBe(0);
  });

  it('approve in full: only the received cash moves van -> office; receipts settled, bank verified', async () => {
    const cash = await collect(vanCash, 300);
    const viaBank = await collect(bank, 150);
    const created = await submit([cash.id, viaBank.id] as string[], { countedCash: 300 });
    const approved = await approve(created.id as string, 300);

    expect(approved.toJSON()).toMatchObject({
      status: 'approved',
      receivedCash: 300,
      receivedIntoAccountName: 'Office Cash',
      varianceReason: null,
      grandTotal: 300,
      approvedBy: { name: 'Approver' },
    });
    expect(await h.balanceOf(vanCash)).toBe(0);
    expect(await h.balanceOf(officeCash)).toBe(300);
    // The bank receipt is only verified: its 150 stays where it was posted.
    expect(await h.balanceOf(bank)).toBe(150);
    const entries = (await h.models.entry.find({ voucherId: created._id }).lean().exec()) as unknown as {
      accountId: Types.ObjectId;
      debit: number;
      credit: number;
    }[];
    expect(entries.map((entry) => [entry.accountId.toString(), entry.debit, entry.credit])).toEqual(
      expect.arrayContaining([
        [vanCash.id, 0, 300],
        [officeCash.id, 300, 0],
      ]),
    );
    expect(entries).toHaveLength(2);
    for (const receipt of [cash, viaBank]) {
      expect((await statusOf(receipt.id as string)).settlementStatus).toBe('settled');
    }
    await expect(approve(created.id as string, 300)).rejects.toThrow(/is approved and cannot be approved/);
    await expectReconciled();
  });

  it('approve short needs a reason and leaves the shortage in the van; more is refused', async () => {
    const cash = await collect(vanCash, 500);
    const created = await submit([cash.id as string], { countedCash: 480 });

    await expect(approve(created.id as string, 501)).rejects.toThrow(/more than the expected 500.00/);
    await expect(approve(created.id as string, 480)).rejects.toThrow(/20.00 short: a varianceReason is required/);
    expect(await h.models.entry.countDocuments({ voucherId: created._id })).toBe(0);

    await approve(created.id as string, 480, 'Counted short at the office');
    expect(await h.balanceOf(vanCash)).toBe(20);
    expect(await h.balanceOf(officeCash)).toBe(480);
    expect((await h.handovers.findById(created.id as string)).varianceReason).toBe('Counted short at the office');
    await expectReconciled();
  });

  it('a submitter cannot approve their own handover unless the company allows it', async () => {
    const cash = await collect(vanCash, 100);
    const created = await submit([cash.id as string]);
    await expect(approve(created.id as string, 100, undefined, office)).rejects.toThrow(/someone else must approve/);

    await h.company.update({ legalName: 'ALA DATES LLC', allowSelfApproval: true }, office);
    await approve(created.id as string, 100, undefined, office);
    expect(await h.balanceOf(officeCash)).toBe(100);
  });

  it('reject needs a reason, unlocks the receipts and posts nothing; they can be submitted again', async () => {
    const cash = await collect(vanCash, 100);
    const created = await submit([cash.id as string]);
    const server = h.app.getHttpServer();
    h.harness.tokenUser = approver;
    expect((await request(server).post(`/cash-handovers/${created.id}/reject`).send({})).status).toBe(400);
    const res = await request(server).post(`/cash-handovers/${created.id}/reject`).send({ reason: 'Wrong receipts' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'rejected', rejectReason: 'Wrong receipts' });

    expect(await statusOf(cash.id as string)).toMatchObject({ settlementStatus: 'unsettled', handoverId: null });
    expect(await h.models.entry.countDocuments({ voucherId: created._id })).toBe(0);
    await expect(approve(created.id as string, 100)).rejects.toThrow(/is rejected/);
    expect((await submit([cash.id as string])).voucherNo).toBe('CH-0002');
  });

  it('cancel: the submitter may before approval; an approved one needs :cancel and is reversed', async () => {
    const cash = await collect(vanCash, 100);
    const submitter = makeUser('Rashid', [Permission.CASH_HANDOVERS_READ, Permission.CASH_HANDOVERS_CREATE]);
    const first = await submit([cash.id as string], {}, submitter);
    await expect(h.handovers.cancel(first.id as string, { reason: 'Not mine' }, makeUser('Other', []))).rejects.toThrow(
      /Only the submitter/,
    );
    await h.handovers.cancel(first.id as string, { reason: 'Wrong day' }, submitter);
    expect((await statusOf(cash.id as string)).settlementStatus).toBe('unsettled');

    const second = await submit([cash.id as string]);
    await approve(second.id as string, 100);
    await expect(h.handovers.cancel(second.id as string, { reason: 'Mistake' }, submitter)).rejects.toThrow(
      /needs the cash-handovers:cancel permission/,
    );
    const cancelled = await h.handovers.cancel(second.id as string, { reason: 'Approved by mistake' }, office);
    expect(cancelled.status).toBe('cancelled');
    expect(await h.balanceOf(vanCash)).toBe(100);
    expect(await h.balanceOf(officeCash)).toBe(0);
    expect(await statusOf(cash.id as string)).toMatchObject({ settlementStatus: 'unsettled', handoverId: null });
    expect((await h.audit.findForEntity('cash-handover', second._id)).map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['created', 'approved', 'cancelled']),
    );
    await expectReconciled();
  });

  it('lists with filters, shows unsettled receipts and prints CASH HANDOVER SLIP', async () => {
    const cash = await collect(vanCash, 100);
    const viaBank = await collect(bank, 40);
    expect(await h.handovers.unsettled({ staffId: van.id as string }, office)).toMatchObject({
      receipts: [{ voucherNo: cash.voucherNo }, { voucherNo: viaBank.voucherNo }],
      totals: { cash: 100, bank: 40 },
    });
    const created = await submit([cash.id, viaBank.id] as string[]);
    expect((await h.handovers.unsettled({ staffId: van.id as string }, office)).receipts).toEqual([]);

    const page = await h.handovers.findAll({ handoverStatus: 'submitted', staffId: van.id as string });
    expect(page.items).toMatchObject([
      { voucherNo: 'CH-0001', staff: { name: 'Van 1' }, expectedCash: 100, bankTotal: 40, receiptCount: 2 },
    ]);
    expect((await h.handovers.findAll({ handoverStatus: 'approved' })).items).toEqual([]);

    const printed = await h.handovers.print(created.id as string, office);
    const text = JSON.stringify(printed.definition);
    expect(text).toContain('CASH HANDOVER SLIP');
    expect(text).toContain(cash.voucherNo);
  });

  describe('access', () => {
    async function scopedSalesman(): Promise<AuthenticatedUser> {
      const user = await userModel.create({ email: 'r@ala.ae', passwordHash: 'x', name: 'Rashid', role: new Types.ObjectId() });
      await h.cashiers.update(van.id as string, { linkedUserId: user.id as string }, office);
      return {
        ...makeUser('Rashid', [...VAN_SALESMAN_PERMISSIONS]),
        id: user.id as string,
        dataScope: DataScope.OWN,
        allowedCashAccountIds: [vanCash.id as string],
      };
    }

    it('a salesman submits for themself, sees only their own, and cannot approve', async () => {
      const other = await h.cashiers.create({ name: 'Van 2', staffType: StaffType.VAN_SALESMAN }, office);
      const mine = await collect(vanCash, 100);
      const theirs = await collect(vanCash, 70, other);
      const theirHandover = await submit([theirs.id as string], { staffId: other.id as string });
      h.harness.tokenUser = await scopedSalesman();
      const server = h.app.getHttpServer();

      const unsettled = await request(server).get('/cash-handovers/unsettled');
      expect(unsettled.body.receipts.map((r: { id: string }) => r.id)).toEqual([mine.id]);
      const body = { voucherDate: '2026-10-02', sourceAccountId: vanCash.id, receiptIds: [mine.id], countedCash: 100 };
      expect((await request(server).post('/cash-handovers').send({ ...body, staffId: other.id })).status).toBe(403);
      expect((await request(server).post('/cash-handovers').send({ ...body, sourceAccountId: officeCash.id })).status).toBe(
        403,
      );
      const res = await request(server).post('/cash-handovers').send(body);
      expect(res.status).toBe(201);

      const list = await request(server).get('/cash-handovers');
      expect(list.body.items.map((row: { id: string }) => row.id)).toEqual([res.body.id]);
      expect((await request(server).get(`/cash-handovers/${theirHandover.id}`)).status).toBe(404);
      const approveBody = { receivedCash: 100, receivedIntoAccountId: officeCash.id };
      expect((await request(server).post(`/cash-handovers/${res.body.id}/approve`).send(approveBody)).status).toBe(403);
      expect((await request(server).post(`/cash-handovers/${res.body.id}/reject`).send({ reason: 'x'.repeat(5) })).status).toBe(
        403,
      );
      // Their own submitted one they may cancel.
      expect((await request(server).post(`/cash-handovers/${res.body.id}/cancel`).send({ reason: 'Wrong day' })).status).toBe(
        201,
      );
    });

    it('route permissions; Accountant has all four, Van Salesman read + create', () => {
      const required = (method: keyof CashHandoverController) =>
        Reflect.getMetadata(REQUIRE_PERMISSION_KEY, CashHandoverController.prototype[method]);
      expect(required('approve')).toEqual([Permission.CASH_HANDOVERS_APPROVE]);
      expect(required('reject')).toEqual([Permission.CASH_HANDOVERS_APPROVE]);
      expect(required('create')).toEqual([Permission.CASH_HANDOVERS_CREATE]);
      for (const permission of [
        Permission.CASH_HANDOVERS_READ,
        Permission.CASH_HANDOVERS_CREATE,
        Permission.CASH_HANDOVERS_APPROVE,
        Permission.CASH_HANDOVERS_CANCEL,
      ]) {
        expect(ACCOUNTANT_PERMISSIONS).toContain(permission);
      }
      expect(VAN_SALESMAN_PERMISSIONS.filter((p) => p.startsWith('cash-handovers'))).toEqual([
        Permission.CASH_HANDOVERS_READ,
        Permission.CASH_HANDOVERS_CREATE,
      ]);
    });
  });

  it('backfill: old receipts of settling staff settled, old posted handovers approved', async () => {
    const accountant = await h.cashiers.create({ name: 'Accounts', staffType: StaffType.ACCOUNTANT }, office);
    const date = new Date('2026-09-01');
    const [vanReceipt, deskReceipt] = await h.models.receipt.collection.insertMany([
      { voucherNo: 'CR000901', voucherDate: date, cashierId: van._id, status: 'posted', grandTotal: 10, lines: [] },
      { voucherNo: 'CR000902', voucherDate: date, cashierId: accountant._id, status: 'posted', grandTotal: 10, lines: [] },
    ]).then((result) => Object.values(result.insertedIds));
    await h.models.handover.collection.insertOne({
      voucherNo: 'CH-0900',
      voucherDate: date,
      cashierId: van._id,
      fromAccountId: vanCash._id,
      status: 'posted',
      grandTotal: 75,
      lines: [{ accountId: officeCash._id, amount: 75, vat: 0, netAmount: 75 }],
    });
    const models = { cashier: h.models.cashier, receipt: h.models.receipt as never, handover: h.models.handover as never };

    expect(await backfillHandoverApproval(models)).toEqual({ settledReceipts: 1, otherReceipts: 1, approvedHandovers: 1 });
    expect(await backfillHandoverApproval(models)).toEqual({ settledReceipts: 0, otherReceipts: 0, approvedHandovers: 0 });
    expect(await h.models.receipt.collection.findOne({ _id: vanReceipt })).toMatchObject({
      settlementStatus: 'settled',
      settledAt: date,
    });
    expect(await h.models.receipt.collection.findOne({ _id: deskReceipt })).toMatchObject({ settlementStatus: null });
    expect(await h.models.handover.collection.findOne({ voucherNo: 'CH-0900' })).toMatchObject({
      status: 'approved',
      expectedCash: 75,
      receivedCash: 75,
      receivedIntoAccountId: officeCash._id,
      approvedAt: date,
    });
  });
});
