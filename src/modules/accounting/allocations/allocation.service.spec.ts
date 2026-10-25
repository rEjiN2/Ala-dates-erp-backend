import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import request from 'supertest';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../../test/voucher-test-module.js';
import { LedgerAccountType, type LedgerAccountDocument } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { AllocationTargetType, PaymentStatus } from './schemas/allocation.schema.js';
import { PartyKind, PartyStatus } from '../../party/schemas/party.schema.js';
import { VoucherStatus } from '../vouchers/schemas/voucher.schema.js';
import { Permission } from '../../roles/permissions.js';

const { CASH, SUPPLIER } = LedgerAccountType;
const PI = AllocationTargetType.PURCHASE_INVOICE;

describe('Allocations (payments to bills)', () => {
  let h: VoucherHarness;
  const sachin = makeUser('Sachin');

  beforeAll(async () => {
    h = await createVoucherHarness('allocations');
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  beforeEach(async () => {
    await h.persistUser(sachin);
  });

  afterEach(async () => {
    h.harness.tokenUser = sachin;
    await h.reset();
  });

  async function fixtures() {
    const cash = await h.makeAccount('CASH-0001', CASH, 0, 'Main Cash');
    const supplierAccount = await h.makeAccount('SUP-0001', SUPPLIER, 0, 'Omar Farms');
    const otherAccount = await h.makeAccount('SUP-0002', SUPPLIER, 0, 'Other Farms');
    const party = async (account: LedgerAccountDocument) =>
      (await h.models.party.create({
        code: account.code,
        kind: PartyKind.SUPPLIER,
        name: account.name,
        status: PartyStatus.ACTIVE,
        ledgerAccountId: account._id,
      })) as unknown as { _id: Types.ObjectId };
    const supplier = await party(supplierAccount);
    const other = await party(otherAccount);
    // Invoices are inserted directly: only their payment fields matter here.
    const invoice = async (voucherNo: string, netTotal: number, supplierId = supplier._id) =>
      (await h.models.purchaseInvoice.create({
        voucherNo,
        voucherDate: new Date('2026-09-01'),
        supplierId,
        supplierAccountId: supplierAccount._id,
        locationId: new Types.ObjectId(),
        billNo: `B-${voucherNo}`,
        dueDate: new Date('2026-09-30'),
        netTotal,
        balance: netTotal,
        status: VoucherStatus.POSTED,
      })) as unknown as { _id: Types.ObjectId };
    return { cash, supplierAccount, supplier, other, invoice };
  }

  const pay = (
    f: Awaited<ReturnType<typeof fixtures>>,
    amount: number,
    allocations: { targetType: AllocationTargetType; targetId: Types.ObjectId; amount: number }[] = [],
  ) =>
    h.payments.create(
      {
        voucherDate: '2026-10-01',
        paidFromAccountId: f.cash.id,
        acknowledgeWarnings: true,
        lines: [
          {
            accountId: f.supplierAccount.id,
            amount,
            allocations: allocations.map((a) => ({ ...a, targetId: a.targetId.toString() })),
          },
        ],
      },
      sachin,
    );

  const invoiceState = async (id: Types.ObjectId) =>
    (await h.models.purchaseInvoice.findById(id).lean().exec()) as unknown as {
      paidAmount: number;
      balance: number;
      paymentStatus: PaymentStatus;
    };

  async function expectBalancesMatchEntries() {
    const sums = await h.models.entry
      .aggregate<{ _id: Types.ObjectId; net: number }>([
        { $group: { _id: '$accountId', net: { $sum: { $subtract: ['$debit', '$credit'] } } } },
      ])
      .exec();
    for (const account of await h.models.account.find().lean().exec()) {
      const sum = sums.find((row) => row._id.equals(account._id))?.net ?? 0;
      expect(Math.round(account.balance * 100)).toBe(Math.round(sum * 100));
    }
  }

  it('part payment makes an invoice partly paid, the rest makes it paid; cancelling restores it', async () => {
    const f = await fixtures();
    const inv = await f.invoice('PI-0001', 1000);

    const first = await pay(f, 400, [{ targetType: PI, targetId: inv._id, amount: 400 }]);
    expect(await invoiceState(inv._id)).toMatchObject({ paidAmount: 400, balance: 600, paymentStatus: PaymentStatus.PARTLY_PAID });

    // 700 paid, 600 allocated: the remaining 100 stays on account.
    await pay(f, 700, [{ targetType: PI, targetId: inv._id, amount: 600 }]);
    expect(await invoiceState(inv._id)).toMatchObject({ paidAmount: 1000, balance: 0, paymentStatus: PaymentStatus.PAID });
    const onAccount = await h.allocations.unallocatedPayments(f.supplier._id.toString());
    expect(onAccount).toHaveLength(1);
    expect(onAccount[0]).toMatchObject({ amount: 700, allocated: 600, unallocated: 100 });

    await h.payments.cancel(first.id, { reason: 'Wrong amount' }, sachin);
    expect(await invoiceState(inv._id)).toMatchObject({ paidAmount: 600, balance: 400, paymentStatus: PaymentStatus.PARTLY_PAID });
    expect(await h.models.allocation.countDocuments({ status: 'reversed' })).toBe(1);
    await expectBalancesMatchEntries();
  });

  it('refuses over-allocation of a line or a bill, and a bill of another party', async () => {
    const f = await fixtures();
    const inv = await f.invoice('PI-0001', 300);
    const others = await f.invoice('PI-0002', 300, f.other._id);

    await expect(pay(f, 200, [{ targetType: PI, targetId: inv._id, amount: 250 }])).rejects.toThrow(/exceed the line amount/);
    await expect(pay(f, 500, [{ targetType: PI, targetId: inv._id, amount: 400 }])).rejects.toThrow(/more than the PI-0001 balance/);
    await expect(pay(f, 100, [{ targetType: PI, targetId: others._id, amount: 50 }])).rejects.toThrow(/another party/);
    // Nothing was saved by the refused payments.
    expect(await h.models.payment.countDocuments()).toBe(0);
    expect(await invoiceState(inv._id)).toMatchObject({ paidAmount: 0, balance: 300 });
  });

  it('applies an on-account payment later, lists open bills incl. opening balance, and reverses', async () => {
    const f = await fixtures();
    const inv = await f.invoice('PI-0001', 500);
    const opening = await h.openingBalances.create(
      { asOfDate: '2026-01-01', lines: [{ accountId: f.supplierAccount.id, credit: 200 }] },
      sachin,
    );
    const payment = await pay(f, 600);

    let bills = await h.allocations.openBills(f.supplier._id.toString());
    expect(bills.map((bill) => [bill.number, bill.balance, bill.overdue])).toEqual([
      [opening.voucherNo, 200, true],
      ['PI-0001', 500, true],
    ]);

    const res = await request(h.app.getHttpServer())
      .post('/allocations')
      .send({
        paymentVoucherType: 'cash-payment',
        paymentVoucherId: payment.id,
        paymentLineIndex: 0,
        targetType: AllocationTargetType.OPENING_BALANCE,
        targetId: opening.id,
        amount: 200,
      })
      .expect(201);
    await h.allocations.create(
      { paymentVoucherType: 'cash-payment', paymentVoucherId: payment.id, paymentLineIndex: 0, targetType: PI, targetId: inv._id.toString(), amount: 400 },
      sachin,
    );
    bills = await h.allocations.openBills(f.supplier._id.toString());
    expect(bills.map((bill) => [bill.number, bill.balance])).toEqual([['PI-0001', 100]]);
    await expect(
      h.openingBalances.cancel(opening.id, { reason: 'Wrong opening' }, sachin),
    ).rejects.toThrow(new RegExp(`payments allocated \\(${payment.voucherNo}\\)`));

    await request(h.app.getHttpServer()).post(`/allocations/${res.body._id}/reverse`).send({ reason: 'Applied wrongly' }).expect(201);
    expect((await h.allocations.unallocatedPayments(f.supplier._id.toString()))[0]).toMatchObject({ unallocated: 200 });

    h.harness.tokenUser = makeUser('Viewer', [Permission.CASH_PAYMENTS_READ]);
    await request(h.app.getHttpServer()).get(`/parties/${f.supplier._id.toString()}/open-bills`).expect(403);
    await request(h.app.getHttpServer()).post(`/allocations/${res.body._id}/reverse`).send({ reason: 'Applied wrongly' }).expect(403);
    await expectBalancesMatchEntries();
  });

  it('a payment edit reverses and reposts its allocations', async () => {
    const f = await fixtures();
    const inv = await f.invoice('PI-0001', 1000);
    const payment = await pay(f, 300, [{ targetType: PI, targetId: inv._id, amount: 300 }]);

    await h.payments.update(
      payment.id,
      { lines: [{ accountId: f.supplierAccount.id, amount: 300, allocations: [{ targetType: PI, targetId: inv._id.toString(), amount: 100 }] }] },
      sachin,
    );
    expect(await invoiceState(inv._id)).toMatchObject({ paidAmount: 100, balance: 900 });
    const audit = await h.models.audit.findOne({ entityType: 'cash-payment', action: 'updated' }).lean().exec();
    expect((audit as unknown as { changes: { field: string }[] }).changes.map((c) => c.field)).toContain('allocations');
    await expectBalancesMatchEntries();
  });
});
