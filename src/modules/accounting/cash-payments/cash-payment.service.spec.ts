import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import request from 'supertest';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../../test/voucher-test-module.js';
import { LedgerAccountStatus, LedgerAccountType } from '../ledger-accounts/schemas/ledger-account.schema.js';
import type { LedgerAccountDocument } from '../ledger-accounts/schemas/ledger-account.schema.js';
import { CashierStatus, type CashierDocument } from '../../cashier/schemas/cashier.schema.js';
import { VoucherWarningsException } from '../vouchers/voucher-posting.service.js';
import { CreateCashPaymentDto, UpdateCashPaymentDto } from './dto/cash-payment.dto.js';
import { createAppValidationPipe } from '../../../common/pipes/app-validation.pipe.js';
import { Permission } from '../../roles/permissions.js';
import { CashPaymentController } from './cash-payment.controller.js';
import { REQUIRE_PERMISSION_KEY } from '../../../common/decorators/require-permission.decorator.js';

const { CASH, WALLET, BANK, PARTY, SUPPLIER, INCOME, EXPENSE, OTHER } = LedgerAccountType;

describe('CashPaymentService', () => {
  let h: VoucherHarness;
  let cashier: CashierDocument;
  const sachin = makeUser('Sachin');
  const omar = makeUser('Omar');

  beforeAll(async () => {
    h = await createVoucherHarness('cash_payments');
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  beforeEach(async () => {
    cashier = await h.cashiers.create({ name: 'Sachin' }, sachin);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    h.harness.tokenUser = sachin;
    await h.reset();
  });

  /** A cash account with 1000 in it and a supplier owed 500 (balance -500). */
  async function accounts() {
    return {
      cash: await h.makeAccount('CASH-0001', CASH, 1000, 'Main Cash'),
      wallet: await h.makeAccount('WAL-0001', WALLET, 30, 'STC Pay'),
      bank: await h.makeAccount('BNK-0001', BANK, 0, 'ADCB'),
      supplier: await h.makeAccount('SUP-0001', SUPPLIER, -500, 'Omar Farms'),
      customer: await h.makeAccount('CUS-0001', PARTY, 0, 'Ali Traders'),
      expense: await h.makeAccount('EXP-0001', EXPENSE, 0, 'Rent'),
      income: await h.makeAccount('INC-0001', INCOME, 0, 'Scrap Sales'),
      other: await h.makeAccount('OTH-0001', OTHER, 0, 'Suspense'),
    };
  }

  const pay = (
    from: LedgerAccountDocument,
    lines: { account: LedgerAccountDocument; amount: number; vat?: number; narration?: string }[],
    extra: Partial<CreateCashPaymentDto> = {},
    actor = sachin,
  ) =>
    h.payments.create(
      {
        voucherDate: '2026-10-01',
        paidFromAccountId: from.id,
        cashierId: cashier.id,
        lines: lines.map(({ account, ...line }) => ({ accountId: account.id, ...line })),
        ...extra,
      },
      actor,
    );

  const entriesOf = async (voucherId: Types.ObjectId) =>
    (await h.models.entry.find({ voucherId }).sort({ _id: 1 }).lean().exec()) as unknown as {
      accountId: Types.ObjectId;
      debit: number;
      credit: number;
      kind: string;
      cause: string;
    }[];

  describe('posting', () => {
    it('credits the paid-from account and debits each line: the opposite of a receipt', async () => {
      const { cash, supplier } = await accounts();

      const payment = await pay(cash, [{ account: supplier, amount: 100, vat: 5, narration: 'Invoice 9' }]);
      expect(payment).toMatchObject({
        voucherNo: 'CP-0001',
        grossTotal: 100,
        totalTax: 5,
        grandTotal: 105,
        paymentMethod: 'cash',
      });
      expect(payment.lines[0]).toMatchObject({ oldBalance: -500, netAmount: 105 });
      expect(await h.balanceOf(cash)).toBe(895);
      expect(await h.balanceOf(supplier)).toBe(-395);

      const entries = await entriesOf(payment._id);
      expect(entries.map((e) => [e.accountId.toString(), e.debit, e.credit, e.kind])).toEqual([
        [cash.id, 0, 105, 'posting'],
        [supplier.id, 105, 0, 'posting'],
      ]);

      // The same amounts as a receipt move both balances back.
      await h.receipts.create(
        {
          voucherDate: '2026-10-01',
          cashAccountId: cash.id,
          cashierId: cashier.id,
          lines: [{ accountId: supplier.id, amount: 100, vat: 5 }],
        },
        sachin,
      );
      expect(await h.balanceOf(cash)).toBe(1000);
      expect(await h.balanceOf(supplier)).toBe(-500);
    });

    it('gives parallel saves unique, gapless numbers', async () => {
      const { cash, expense } = await accounts();
      const payments = await Promise.all(
        Array.from({ length: 10 }, () => pay(cash, [{ account: expense, amount: 1 }])),
      );

      expect(payments.map((p) => p.voucherNo).sort()).toEqual(
        Array.from({ length: 10 }, (_, i) => `CP-${String(i + 1).padStart(4, '0')}`),
      );
      expect(await h.balanceOf(cash)).toBe(990);
      expect(await h.balanceOf(expense)).toBe(10);
    });

    it('writes nothing at all when the transaction fails part-way', async () => {
      const { cash, supplier } = await accounts();
      const record = h.audit.record.bind(h.audit);
      vi.spyOn(h.audit, 'record').mockImplementationOnce(async (entry, session) => {
        await record(entry, session);
        throw new Error('disk full');
      });

      await expect(pay(cash, [{ account: supplier, amount: 100 }])).rejects.toThrow('disk full');
      expect(await h.models.payment.countDocuments().exec()).toBe(0);
      expect(await h.models.entry.countDocuments().exec()).toBe(0);
      expect(await h.models.audit.countDocuments({ entityType: 'cash-payment' }).exec()).toBe(0);
      expect(await h.balanceOf(cash)).toBe(1000);
      expect(await h.balanceOf(supplier)).toBe(-500);
      expect((await pay(cash, [{ account: supplier, amount: 100 }])).voucherNo).toBe('CP-0001');
    });

    it('requires an active cashier and takes no server-owned fields from the body', async () => {
      const { cash, supplier } = await accounts();
      await h.cashiers.update(cashier.id, { status: CashierStatus.INACTIVE }, sachin);
      await expect(pay(cash, [{ account: supplier, amount: 10 }])).rejects.toThrow(/is inactive/);

      const pipe = createAppValidationPipe();
      const body = {
        voucherDate: '2026-10-01',
        paidFromAccountId: cash.id,
        cashierId: cashier.id,
        lines: [{ accountId: supplier.id, amount: 10 }],
      };
      for (const extra of [
        { voucherNo: 'CP-9999' },
        { grandTotal: 1 },
        { paymentMethod: 'bank' },
        { createdBy: { id: sachin.id, name: 'X' } },
      ]) {
        await expect(
          pipe.transform({ ...body, ...extra }, { type: 'body', metatype: CreateCashPaymentDto }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      // Optional in the body (an "own"-scoped user gets their linked cashier), but required by the service otherwise.
      const { cashierId: _cashierId, ...withoutCashier } = body;
      await expect(
        h.payments.create(withoutCashier as unknown as CreateCashPaymentDto, sachin),
      ).rejects.toThrow('cashierId is required');
    });
  });

  describe('account types', () => {
    it('accepts cash, wallet and bank as paid-from, and a bank payment prints as one', async () => {
      const { bank, wallet, cash, supplier } = await accounts();
      expect((await pay(cash, [{ account: supplier, amount: 1 }])).paymentMethod).toBe('cash');
      expect((await pay(wallet, [{ account: supplier, amount: 1 }])).paymentMethod).toBe('cash');
      expect((await pay(bank, [{ account: supplier, amount: 1 }], { acknowledgeWarnings: false })).paymentMethod).toBe(
        'bank',
      );
    });

    it('rejects any other paid-from account, and an inactive one', async () => {
      const { customer, expense, supplier } = await accounts();
      for (const from of [customer, expense, supplier]) {
        await expect(pay(from, [{ account: expense === from ? customer : expense, amount: 1 }])).rejects.toThrow(
          `${from.code} (${from.name}) is a ${from.type} account. Choose a cash, wallet or bank account.`,
        );
      }
      const closed = await h.makeAccount('CASH-0009', CASH, 100, 'Closed Till', LedgerAccountStatus.INACTIVE);
      await expect(pay(closed, [{ account: customer, amount: 1 }])).rejects.toThrow(/inactive/);
    });

    it('accepts supplier, customer, expense, income and other lines', async () => {
      const { cash, supplier, customer, expense, income, other } = await accounts();
      const payment = await pay(
        cash,
        [supplier, customer, expense, income, other].map((account) => ({ account, amount: 10 })),
      );
      expect(payment.grandTotal).toBe(50);
    });

    it('rejects cash, wallet and bank lines, and the paid-from account on a line', async () => {
      const { cash, wallet, bank, supplier } = await accounts();

      await expect(
        pay(cash, [
          { account: supplier, amount: 5 },
          { account: bank, amount: 5 },
        ]),
      ).rejects.toThrow(
        "Line 2: BNK-0001 (ADCB) is a bank account. Money can't be paid to the company's own cash, wallet or bank accounts; choose a supplier, customer, expense, income or other account.",
      );
      await expect(pay(bank, [{ account: wallet, amount: 5 }])).rejects.toThrow(
        /Line 1: WAL-0001 \(STC Pay\) is a wallet account/,
      );
      await expect(pay(cash, [{ account: cash, amount: 5 }])).rejects.toThrow(
        'The "paid from" account cannot also be used on a line',
      );
      expect(await h.models.payment.countDocuments().exec()).toBe(0);
      expect(await h.balanceOf(cash)).toBe(1000);
    });
  });

  describe('overspending warning', () => {
    it('refuses to take cash below zero without acknowledgement, saving nothing, then saves when acknowledged', async () => {
      const { cash, supplier } = await accounts();

      const attempt = pay(cash, [{ account: supplier, amount: 1200 }]);
      await expect(attempt).rejects.toBeInstanceOf(VoucherWarningsException);
      const error = (await attempt.catch((e: unknown) => e)) as VoucherWarningsException;
      expect(error.getStatus()).toBe(409);
      expect(error.warnings).toEqual([
        {
          code: 'NEGATIVE_BALANCE',
          accountId: cash.id,
          accountCode: 'CASH-0001',
          accountName: 'Main Cash',
          balanceBefore: 1000,
          balanceAfter: -200,
          message: 'This cash payment takes Main Cash (CASH-0001) below zero: 1000.00 becomes -200.00.',
        },
      ]);
      expect(await h.models.payment.countDocuments().exec()).toBe(0);
      expect(await h.models.entry.countDocuments().exec()).toBe(0);
      expect(await h.balanceOf(cash)).toBe(1000);

      const saved = await pay(cash, [{ account: supplier, amount: 1200 }], { acknowledgeWarnings: true });
      expect(saved.voucherNo).toBe('CP-0001');
      expect(await h.balanceOf(cash)).toBe(-200);
    });

    it('returns the warnings in the HTTP 409 body', async () => {
      const { wallet, expense } = await accounts();
      const body = {
        voucherDate: '2026-10-01',
        paidFromAccountId: wallet.id,
        cashierId: cashier.id,
        lines: [{ accountId: expense.id, amount: 50 }],
      };

      const refused = await request(h.app.getHttpServer()).post('/cash-payments').send(body);
      expect(refused.status).toBe(409);
      expect(refused.body.warnings).toEqual([
        expect.objectContaining({ code: 'NEGATIVE_BALANCE', accountCode: 'WAL-0001', balanceAfter: -20 }),
      ]);
      expect(refused.body.message).toMatch(/acknowledgeWarnings: true/);

      const accepted = await request(h.app.getHttpServer())
        .post('/cash-payments')
        .send({ ...body, acknowledgeWarnings: true });
      expect(accepted.status).toBe(201);
    });

    it('exempts bank accounts', async () => {
      const { bank, supplier } = await accounts();
      await pay(bank, [{ account: supplier, amount: 5000 }]);
      expect(await h.balanceOf(bank)).toBe(-5000);
    });

    it('warns on an edit that takes cash further below zero, but not on one that leaves it as it was', async () => {
      const { cash, supplier } = await accounts();
      const payment = await pay(cash, [{ account: supplier, amount: 1100 }], { acknowledgeWarnings: true });

      await expect(h.payments.update(payment.id, { comments: 'Checked' }, sachin)).resolves.toBeDefined();
      await expect(
        h.payments.update(payment.id, { lines: [{ accountId: supplier.id, amount: 1300 }] }, sachin),
      ).rejects.toBeInstanceOf(VoucherWarningsException);
      expect(await h.balanceOf(cash)).toBe(-100);
      await h.payments.update(
        payment.id,
        { lines: [{ accountId: supplier.id, amount: 1300 }], acknowledgeWarnings: true },
        sachin,
      );
      expect(await h.balanceOf(cash)).toBe(-300);
    });
  });

  describe('edit and cancel', () => {
    it('reverses and reposts on edit, restores balances on cancel, and keeps the reversals in the ledger', async () => {
      const { cash, bank, supplier, expense } = await accounts();
      const payment = await pay(cash, [{ account: supplier, amount: 100 }]);

      const edited = await h.payments.update(
        payment.id,
        { paidFromAccountId: bank.id, lines: [{ accountId: expense.id, amount: 250 }], changeNote: 'Paid by transfer' },
        omar,
      );
      expect(edited.paymentMethod).toBe('bank');
      expect(await h.balanceOf(cash)).toBe(1000);
      expect(await h.balanceOf(supplier)).toBe(-500);
      expect(await h.balanceOf(bank)).toBe(-250);
      expect(await h.balanceOf(expense)).toBe(250);

      const [entry] = await h.audit.findForEntity('cash-payment', payment._id);
      expect(entry).toMatchObject({ action: 'updated', actorName: 'Omar', reason: 'Paid by transfer' });
      expect(entry.changes).toEqual(
        expect.arrayContaining([{ field: 'cashAccount', label: 'Paid from', from: 'Main Cash', to: 'ADCB' }]),
      );

      await h.payments.cancel(payment.id, { reason: 'Duplicate' }, omar);
      expect(await h.balanceOf(bank)).toBe(0);
      expect(await h.balanceOf(expense)).toBe(0);
      expect((await entriesOf(payment._id)).map((e) => `${e.kind}:${e.cause}`)).toEqual([
        'posting:created',
        'posting:created',
        'reversal:updated',
        'reversal:updated',
        'posting:updated',
        'posting:updated',
        'reversal:cancelled',
        'reversal:cancelled',
      ]);
    });

    it('needs a cancel reason, refuses edits after cancel, and rejects a no-change edit', async () => {
      const { cash, supplier } = await accounts();
      const payment = await pay(cash, [{ account: supplier, amount: 100 }]);

      await expect(h.payments.update(payment.id, { changeNote: 'nothing' }, sachin)).rejects.toThrow(
        'No changes to save',
      );
      for (const reason of ['', 'ab', '   ']) {
        await expect(h.payments.cancel(payment.id, { reason }, sachin)).rejects.toThrow(/at least 3 characters/);
      }
      await h.payments.cancel(payment.id, { reason: 'Wrong supplier' }, sachin);
      await expect(h.payments.update(payment.id, { comments: 'x' }, sachin)).rejects.toThrow(
        `Cash payment CP-0001 is cancelled and cannot be edited`,
      );
      await expect(h.payments.cancel(payment.id, { reason: 'Again' }, sachin)).rejects.toThrow(
        /cannot be cancelled again/,
      );
      expect(await h.balanceOf(cash)).toBe(1000);

      const pipe = createAppValidationPipe();
      await expect(
        pipe.transform({ voucherNo: 'CP-1' }, { type: 'body', metatype: UpdateCashPaymentDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('list', () => {
    it('filters (including paidFromAccountId) and summarises excluding cancelled payments', async () => {
      const { cash, bank, supplier, expense } = await accounts();
      await pay(cash, [{ account: supplier, amount: 100 }], { paymentReference: 'CHQ 77' });
      await pay(bank, [{ account: expense, amount: 40 }]);
      const third = await pay(cash, [{ account: expense, amount: 10 }]);
      await h.payments.cancel(third.id, { reason: 'Duplicate' }, sachin);

      const all = await h.payments.findAll({});
      expect(all.summary).toEqual({ count: 3, total: 140 });
      expect(all.items[0]).toEqual(
        expect.objectContaining({
          voucherNo: expect.any(String),
          paidFromAccount: expect.any(Object),
          commentCount: 0,
        }),
      );
      expect(all.items[0]).not.toHaveProperty('cashAccount');

      const fromCash = await h.payments.findAll({ paidFromAccountId: cash.id, status: 'posted' });
      expect(fromCash.items.map((row) => [row.voucherNo, row.paidFromAccount])).toEqual([
        ['CP-0001', { id: cash.id, name: 'Main Cash' }],
      ]);
      expect((await h.payments.findAll({ q: 'chq 77' })).items.map((r) => r.voucherNo)).toEqual(['CP-0001']);
      expect((await h.payments.findAll({ accountId: expense.id })).summary).toEqual({ count: 2, total: 40 });
      expect((await h.payments.findAll({ sortBy: 'amount', sortDir: 'desc' })).items.map((r) => r.grandTotal)).toEqual([
        100, 40, 10,
      ]);
    });
  });

  describe('PDF', () => {
    it('prints CASH PAYMENT VOUCHER with a Paid To table and Received by signature, then DUPLICATEs', async () => {
      const { cash, supplier } = await accounts();
      const payment = await pay(cash, [{ account: supplier, amount: 1250.5, narration: 'Dates lot 4' }], {
        acknowledgeWarnings: true,
      });

      const first = await h.payments.print(payment.id, sachin);
      const text = JSON.stringify(first.definition);
      for (const expected of [
        '"CASH PAYMENT VOUCHER"',
        '"ORIGINAL"',
        '"Paid From"',
        '"Paid To"',
        '"Received by"',
        '"Cashier Signature"',
        '"Paid By"',
        '"Prepared by: "',
        'Omar Farms',
        'Dates lot 4',
        'UAE Dirhams One Thousand Two Hundred Fifty and Fifty Fils Only',
      ]) {
        expect(text).toContain(expected);
      }
      expect(text).not.toContain('RECEIPT');
      expect(first.definition.watermark).toBeUndefined();

      const second = await h.payments.print(payment.id, omar);
      expect(JSON.stringify(second.definition)).toContain('DUPLICATE - Reprint 1');
      const prints = (await h.audit.findForEntity('cash-payment', payment._id)).filter((e) => e.action === 'printed');
      expect(prints.map((e) => e.actorName)).toEqual(['Omar', 'Sachin']);
    });

    it('prints BANK PAYMENT VOUCHER for a bank account and watermarks a cancelled payment', async () => {
      const { bank, supplier } = await accounts();
      const payment = await pay(bank, [{ account: supplier, amount: 10 }], { paymentReference: 'TT-55' });
      await h.payments.cancel(payment.id, { reason: 'Bounced' }, omar);

      const { definition } = await h.payments.print(payment.id, sachin);
      const text = JSON.stringify(definition);
      expect(text).toContain('"BANK PAYMENT VOUCHER"');
      expect(text).toContain('TT-55');
      expect(text).toContain('Reason: Bounced');
      expect(definition.watermark).toMatchObject({ text: 'CANCELLED' });
    });

    it('serves the PDF inline over HTTP', async () => {
      const { cash, supplier } = await accounts();
      const payment = await pay(cash, [{ account: supplier, amount: 10 }]);
      const res = await request(h.app.getHttpServer())
        .get(`/cash-payments/${payment.id}/pdf`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe('inline; filename="CP-0001.pdf"');
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    });
  });

  describe('access, comments and activity', () => {
    it('needs cash-payments:read to read or comment, and create/edit/cancel to write', async () => {
      const { cash, supplier } = await accounts();
      const payment = await pay(cash, [{ account: supplier, amount: 10 }]);
      const server = h.app.getHttpServer();

      h.harness.tokenUser = makeUser('Nobody', []);
      expect((await request(server).get('/cash-payments')).status).toBe(403);
      expect((await request(server).get(`/cash-payments/${payment.id}`)).status).toBe(403);
      expect((await request(server).get(`/cash-payments/${payment.id}/pdf`)).status).toBe(403);
      expect(
        (await request(server).get('/comments').query({ entityType: 'cash-payment', entityId: payment.id })).status,
      ).toBe(403);

      h.harness.tokenUser = makeUser('Viewer', [Permission.CASH_PAYMENTS_READ]);
      const body = {
        voucherDate: '2026-10-01',
        paidFromAccountId: cash.id,
        cashierId: cashier.id,
        lines: [{ accountId: supplier.id, amount: 1 }],
      };

      expect((await request(server).post('/cash-payments').send(body)).status).toBe(403);
      expect((await request(server).patch(`/cash-payments/${payment.id}`).send({ comments: 'x' })).status).toBe(403);
      expect((await request(server).post(`/cash-payments/${payment.id}/cancel`).send({ reason: 'Nope' })).status).toBe(
        403,
      );
      expect((await request(server).get('/cash-payments')).status).toBe(200);
      expect((await request(server).get(`/cash-payments/${payment.id}`)).status).toBe(200);

      const comment = await request(server)
        .post('/comments')
        .send({ entityType: 'cash-payment', entityId: payment.id, text: 'Receipt from supplier filed' });
      expect(comment.status).toBe(201);
      const activity = await request(server)
        .get('/activity')
        .query({ entityType: 'cash-payment', entityId: payment.id });
      expect(activity.body.items.map((item: { kind: string }) => item.kind)).toEqual(['comment', 'audit']);
      expect(activity.body.commentCount).toBe(1);
      for (const permission of [
        Permission.CASH_PAYMENTS_READ,
        Permission.CASH_PAYMENTS_CREATE,
        Permission.CASH_PAYMENTS_EDIT,
        Permission.CASH_PAYMENTS_CANCEL,
      ]) {
        expect(makeUser('Admin').permissions).toContain(permission);
      }
      for (const [method, permission] of [
        ['findAll', Permission.CASH_PAYMENTS_READ],
        ['findOne', Permission.CASH_PAYMENTS_READ],
        ['pdf', Permission.CASH_PAYMENTS_READ],
        ['create', Permission.CASH_PAYMENTS_CREATE],
        ['update', Permission.CASH_PAYMENTS_EDIT],
        ['cancel', Permission.CASH_PAYMENTS_CANCEL],
      ] as const) {
        expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, CashPaymentController.prototype[method])).toEqual([
          permission,
        ]);
      }
    });
  });
});
