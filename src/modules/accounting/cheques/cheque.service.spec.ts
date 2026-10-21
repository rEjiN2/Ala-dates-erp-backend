import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../../test/voucher-test-module.js';
import { LedgerAccountType, type LedgerAccountDocument } from '../ledger-accounts/schemas/ledger-account.schema.js';
import {
  ACCOUNTANT_PERMISSIONS,
  ADMIN_PERMISSIONS,
  ADMIN_ROLE_NAME,
  Permission,
  VAN_SALESMAN_PERMISSIONS,
} from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import type { CreateCashReceiptDto } from '../cash-receipts/dto/create-cash-receipt.dto.js';
import { backfillReceiptMethods } from '../../../database/backfill-receipt-methods.js';
import { round2 } from '../../../common/utils/money.util.js';

const { CASH, CHEQUE, BANK, PARTY } = LedgerAccountType;
const DAY = 24 * 60 * 60 * 1000;
/** Today's date, `offset` days away, as YYYY-MM-DD. */
const day = (offset = 0) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

describe('Cheques (receipt cheque lifecycle)', () => {
  let h: VoucherHarness;
  let accountant: AuthenticatedUser;
  let admin: AuthenticatedUser;
  let chequesInHand: LedgerAccountDocument;
  let bank: LedgerAccountDocument;
  let cash: LedgerAccountDocument;
  let customer: LedgerAccountDocument;

  beforeAll(async () => {
    h = await createVoucherHarness('cheques');
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  beforeEach(async () => {
    chequesInHand = await h.makeAccount('CHQ-0001', CHEQUE, 0, 'Cheques in Hand');
    bank = await h.makeAccount('BNK-0001', BANK, 0, 'ADCB');
    cash = await h.makeAccount('CASH-0001', CASH, 0, 'Main Cash');
    customer = await h.makeAccount('CUS-0001', PARTY, 0, 'Ali Traders');
    accountant = await h.persistUser(makeUser('Accountant', [...ACCOUNTANT_PERMISSIONS]));
    admin = await h.persistUser({
      ...makeUser('Admin', [...ADMIN_PERMISSIONS]),
      role: { id: 'admin-role', name: ADMIN_ROLE_NAME },
    });
  });

  afterEach(async () => {
    h.harness.tokenUser = makeUser('Sachin');
    await h.reset();
  });

  const chequeReceipt = (extra: Partial<CreateCashReceiptDto> = {}, amount = 500) =>
    h.receipts.create(
      {
        voucherDate: day(-5),
        cashAccountId: chequesInHand.id as string,
        paymentMethod: 'cheque' as never,
        chequeNumber: '100200',
        chequeBankName: 'Emirates NBD',
        chequeDate: day(-2),
        lines: [{ accountId: customer.id as string, amount }],
        ...extra,
      },
      accountant,
    );

  const balances = async () => ({
    cheques: await h.balanceOf(chequesInHand),
    bank: await h.balanceOf(bank),
    customer: await h.balanceOf(customer),
  });

  async function assertReconciled() {
    for (const account of await h.models.account.find().lean().exec()) {
      const entries = (await h.models.entry.find({ accountId: account._id }).lean().exec()) as unknown as {
        debit: number;
        credit: number;
      }[];
      const net = round2(entries.reduce((sum, entry) => sum + entry.debit - entry.credit, 0));
      expect([account.code, account.balance]).toEqual([account.code, net]);
    }
  }

  describe('cheque receipts', () => {
    it('need the cheque number, date and bank, and a cheque account', async () => {
      await expect(chequeReceipt({ chequeBankName: null, chequeDate: null })).rejects.toThrow(
        'A cheque needs chequeDate, chequeBankName',
      );
      await expect(chequeReceipt({ cashAccountId: cash.id as string })).rejects.toThrow(
        /cash account, so the payment method is cash, not cheque/,
      );
      await expect(
        chequeReceipt({ cashAccountId: bank.id as string, paymentMethod: 'cash' as never }),
      ).rejects.toThrow(/payment method is bank, not cash/);

      const receipt = await chequeReceipt({ chequeDate: day(30) }); // post-dated is fine
      expect(receipt).toMatchObject({ paymentMethod: 'cheque', chequeStatus: 'at_office', chequeNumber: '100200' });
      // Posts like any receipt: Dr cheques in hand, Cr customer.
      expect(await balances()).toEqual({ cheques: 500, bank: 0, customer: -500 });
    });

    it('rejects the same cheque number and bank twice, unless the first was cancelled', async () => {
      const first = await chequeReceipt();
      await expect(chequeReceipt({ chequeBankName: 'emirates nbd' })).rejects.toThrow(/already on CR/);
      await chequeReceipt({ chequeBankName: 'ADCB' });
      await h.receipts.cancel(first.id as string, { reason: 'Wrong customer' }, accountant);
      await expect(chequeReceipt()).resolves.toBeDefined();
    });

    it('are edited and cancelled only while at the office', async () => {
      const receipt = await chequeReceipt();
      await h.receipts.update(receipt.id as string, { chequeNumber: '100201' }, accountant);
      await h.cheques.deposit(receipt.id as string, { bankAccountId: bank.id as string, date: day(-1) }, accountant);
      await expect(h.receipts.update(receipt.id as string, { comments: 'x' }, accountant)).rejects.toThrow(
        /cheque is deposited; undo that/,
      );
      await expect(h.receipts.cancel(receipt.id as string, { reason: 'Bounced?' }, accountant)).rejects.toThrow(/undo that/);
    });
  });

  it('bank and cash balances change only on clear; dates are enforced', async () => {
    const receipt = await chequeReceipt({ chequeDate: day(-2) });
    const id = receipt.id as string;

    await expect(h.cheques.deposit(id, { bankAccountId: bank.id as string, date: day(-3) }, accountant)).rejects.toThrow(
      /cannot be deposited before then/,
    );
    await expect(h.cheques.deposit(id, { bankAccountId: cash.id as string, date: day(-1) }, accountant)).rejects.toThrow(
      /Choose a bank account/,
    );
    await h.cheques.deposit(id, { bankAccountId: bank.id as string, date: day(-1) }, accountant);
    expect(await balances()).toEqual({ cheques: 500, bank: 0, customer: -500 });

    await expect(h.cheques.clear(id, { date: day(-3) }, accountant)).rejects.toThrow(/cannot be cleared before then/);
    await expect(h.cheques.clear(id, { date: day(2) }, accountant)).rejects.toThrow(/future/);
    const cleared = await h.cheques.clear(id, { date: day(0) }, accountant); // into the deposit bank by default
    expect(cleared.chequeStatus).toBe('cleared');
    expect(cleared.chequeClearance).toMatchObject({ accountName: 'ADCB' });
    expect(await balances()).toEqual({ cheques: 0, bank: 500, customer: -500 });
    await expect(h.cheques.clear(id, { date: day(0) }, accountant)).rejects.toThrow(/only a at_office or deposited/);
    await assertReconciled();
  });

  it('a post-dated cheque cannot be deposited or cleared before its date', async () => {
    const receipt = await chequeReceipt({ chequeDate: day(10) });
    await expect(
      h.cheques.deposit(receipt.id as string, { bankAccountId: bank.id as string, date: day(0) }, accountant),
    ).rejects.toThrow(/before then/);
    await expect(
      h.cheques.clear(receipt.id as string, { date: day(0), destinationAccountId: bank.id as string }, accountant),
    ).rejects.toThrow(/before then/);
  });

  it('return restores the customer balance and keeps the receipt, marked returned', async () => {
    const receipt = await chequeReceipt();
    const id = receipt.id as string;
    await h.cheques.deposit(id, { bankAccountId: bank.id as string, date: day(-1) }, accountant);
    const returned = await h.cheques.return(id, { date: day(0), reason: 'Insufficient funds' }, accountant);
    expect(returned).toMatchObject({ status: 'posted', chequeStatus: 'returned' });
    expect(await balances()).toEqual({ cheques: 0, bank: 0, customer: 0 });

    const list = await h.receipts.findAll({ paymentMethod: 'cheque' as never, chequeStatus: 'returned' as never });
    expect(list.items[0].cheque).toMatchObject({ number: '100200', status: 'returned' });
    expect(list.summary).toEqual({ count: 1, total: 0 });
    await assertReconciled();
  });

  it('undo (admin only) restores every balance and the previous status', async () => {
    const receipt = await chequeReceipt();
    const id = receipt.id as string;
    await h.cheques.deposit(id, { bankAccountId: bank.id as string, date: day(-1) }, accountant);
    await h.cheques.clear(id, { date: day(0) }, accountant);

    await expect(h.cheques.undo(id, { reason: 'Wrong bank' }, accountant)).rejects.toThrow(/Only an administrator/);
    expect((await h.cheques.undo(id, { reason: 'Not credited after all' }, admin)).chequeStatus).toBe('deposited');
    expect(await balances()).toEqual({ cheques: 500, bank: 0, customer: -500 });
    expect((await h.cheques.undo(id, { reason: 'Never went to the bank' }, admin)).chequeStatus).toBe('at_office');

    await h.cheques.clear(id, { date: day(0), destinationAccountId: cash.id as string }, accountant);
    expect(await h.balanceOf(cash)).toBe(500);
    await h.cheques.undo(id, { reason: 'Mistake' }, admin);

    await h.cheques.return(id, { date: day(0), reason: 'Signature mismatch' }, accountant);
    expect((await h.cheques.undo(id, { reason: 'Customer re-signed' }, admin)).chequeStatus).toBe('at_office');
    expect(await balances()).toEqual({ cheques: 500, bank: 0, customer: -500 });
    expect(await h.balanceOf(cash)).toBe(0);
    await expect(h.cheques.undo(id, { reason: 'Again' }, admin)).rejects.toThrow(/nothing to undo/);
    await assertReconciled();

    const actions = (
      await h.models.audit.find({ entityType: 'cheque', entityId: receipt._id }).sort({ at: 1, _id: 1 }).lean().exec()
    ).map((entry) => (entry as unknown as { action: string }).action);
    expect(actions).toEqual([
      'deposited',
      'cleared',
      'undone',
      'undone',
      'cleared',
      'undone',
      'returned',
      'undone',
    ]);
  });

  it('lists cheques with a pending summary', async () => {
    await chequeReceipt({ chequeNumber: 'A1', chequeDate: day(-3) }, 100); // overdue
    await chequeReceipt({ chequeNumber: 'A2', chequeDate: day(3) }, 200); // due soon
    await chequeReceipt({ chequeNumber: 'A3', chequeDate: day(30) }, 300);
    const deposited = await chequeReceipt({ chequeNumber: 'A4', chequeDate: day(-1) }, 400);
    await h.cheques.deposit(deposited.id as string, { bankAccountId: bank.id as string, date: day(0) }, accountant);
    const cleared = await chequeReceipt({ chequeNumber: 'A5', chequeDate: day(-1) }, 50);
    await h.cheques.clear(cleared.id as string, { date: day(0), destinationAccountId: bank.id as string }, accountant);

    const all = await h.cheques.findAll({});
    expect(all.items.map((row) => row.chequeNumber)).toEqual(['A1', 'A4', 'A5', 'A2', 'A3']);
    expect(all.summary).toEqual({
      pendingCount: 4,
      pendingTotal: 1000,
      dueSoon: { count: 1, total: 200 },
      overdue: { count: 1, total: 100 },
      depositedPending: { count: 1, total: 400 },
    });
    expect(all.items[0]).toMatchObject({ customer: { name: 'Ali Traders' }, collectedBy: { name: 'Accountant' } });
    expect((await h.cheques.findAll({ status: 'deposited' as never })).items.map((row) => row.chequeNumber)).toEqual(['A4']);
    expect((await h.cheques.findAll({ q: 'a3' })).items.map((row) => row.chequeNumber)).toEqual(['A3']);
    expect((await h.cheques.findAll({ dueFrom: day(0), dueTo: day(7) })).items.map((row) => row.chequeNumber)).toEqual(['A2']);
  });

  it('needs cheques permissions: the accountant has them, a van salesman does not', async () => {
    expect(ACCOUNTANT_PERMISSIONS).toEqual(
      expect.arrayContaining([
        Permission.CHEQUES_READ,
        Permission.CHEQUES_DEPOSIT,
        Permission.CHEQUES_CLEAR,
        Permission.CHEQUES_RETURN,
      ]),
    );
    h.harness.tokenUser = makeUser('Van', [...VAN_SALESMAN_PERMISSIONS]);
    expect((await request(h.app.getHttpServer()).get('/cheques')).status).toBe(403);
    h.harness.tokenUser = accountant;
    expect((await request(h.app.getHttpServer()).get('/cheques')).status).toBe(200);
  });

  it('backfills an explicit payment method from the account, once', async () => {
    const legacy = await h.receipts.create(
      { voucherDate: day(-1), cashAccountId: bank.id as string, lines: [{ accountId: customer.id as string, amount: 5 }] },
      accountant,
    );
    await h.models.receipt.collection.updateOne({ _id: legacy._id }, { $unset: { paymentMethod: '' } });
    expect(await backfillReceiptMethods({ receipt: h.models.receipt as never, account: h.models.account })).toEqual({
      bank: 1,
      cheque: 0,
      cash: 0,
    });
    expect(await backfillReceiptMethods({ receipt: h.models.receipt as never, account: h.models.account })).toEqual({
      bank: 0,
      cheque: 0,
      cash: 0,
    });
  });
});
