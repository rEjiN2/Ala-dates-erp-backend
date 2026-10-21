import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Types } from 'mongoose';
import request from 'supertest';
import { createVoucherHarness, makeUser, type VoucherHarness } from '../../../../test/voucher-test-module.js';
import { LedgerAccountType, type LedgerAccountDocument } from '../ledger-accounts/schemas/ledger-account.schema.js';
import {
  ACCOUNTANT_PERMISSIONS,
  ADMIN_PERMISSIONS,
  DataScope,
  VAN_SALESMAN_PERMISSIONS,
} from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { round2 } from '../../../common/utils/money.util.js';

const { CASH, CHEQUE, BANK, PARTY } = LedgerAccountType;

describe('Cash handover (balance-based)', () => {
  let h: VoucherHarness;
  let van: AuthenticatedUser;
  let accountant: AuthenticatedUser;
  let admin: AuthenticatedUser;
  let vanCash: LedgerAccountDocument;
  let vanCheques: LedgerAccountDocument;
  let officeCash: LedgerAccountDocument;
  let officeCheques: LedgerAccountDocument;
  let customer: LedgerAccountDocument;

  beforeAll(async () => {
    h = await createVoucherHarness('cash_handovers');
  }, 120_000);

  afterAll(async () => {
    await h?.app.close();
  });

  beforeEach(async () => {
    vanCash = await h.makeAccount('CASH-0001', CASH, 0, 'Van 1 Cash');
    vanCheques = await h.makeAccount('CHQ-0001', CHEQUE, 0, 'Van 1 Cheques');
    officeCash = await h.makeAccount('CASH-0002', CASH, 0, 'Office Cash');
    officeCheques = await h.makeAccount('CHQ-0002', CHEQUE, 0, 'Cheques in Hand');
    customer = await h.makeAccount('CUS-0001', PARTY, 0, 'Ali Traders');
    await h.makeAccount('BNK-0001', BANK, 0, 'ADCB');
    van = await h.persistUser({
      ...makeUser('Van 1', [...VAN_SALESMAN_PERMISSIONS]),
      dataScope: DataScope.OWN,
      allowedCashAccountIds: [vanCash.id as string, vanCheques.id as string],
    });
    accountant = await h.persistUser(makeUser('Accountant', [...ACCOUNTANT_PERMISSIONS]));
    admin = await h.persistUser(makeUser('Admin', [...ADMIN_PERMISSIONS]));
    await h.company.ensure();
    await h.models.company
      .updateOne({}, { defaultCashInHandAccountId: officeCash._id, defaultChequesInHandAccountId: officeCheques._id })
      .exec();
  });

  afterEach(async () => {
    h.harness.tokenUser = makeUser('Sachin');
    await h.reset();
  });

  const receive = (into: LedgerAccountDocument, amount: number, paymentReference?: string) =>
    h.receipts.create(
      {
        voucherDate: '2026-10-01',
        cashAccountId: into.id as string,
        paymentReference,
        lines: [{ accountId: customer.id as string, amount }],
      },
      van,
    );

  const submit = (cash: number, cheques: number, actor: AuthenticatedUser = van, userId?: string) =>
    h.handovers.create(
      {
        userId,
        lines: [
          ...(cash ? [{ sourceAccountId: vanCash.id as string, amount: cash }] : []),
          ...(cheques ? [{ sourceAccountId: vanCheques.id as string, amount: cheques }] : []),
        ],
      },
      actor,
    );

  const id = (doc: { _id: Types.ObjectId }) => doc._id.toString();
  const pending = () => h.handovers.pending({}, van);

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

  it('cheque receipts need the cheque number and land in a cheque account', async () => {
    await expect(receive(vanCheques, 300)).rejects.toThrow(/cheque number/);
    const receipt = await receive(vanCheques, 300, 'CHQ 1001');
    expect(receipt.paymentMethod).toBe('cheque');
    expect(await h.balanceOf(vanCheques)).toBe(300);
  });

  it('pending equals his own account balances, less what is already submitted', async () => {
    await receive(vanCash, 500);
    await receive(vanCheques, 300, 'CHQ 1001');
    expect((await pending()).totals).toEqual({ balance: 800, submitted: 0, available: 800 });

    await expect(submit(600, 0)).rejects.toThrow(/500.00 available/);
    await submit(200, 300);
    const now = await pending();
    expect(now.totals).toEqual({ balance: 800, submitted: 500, available: 300 });
    expect(now.accounts.map((a) => [a.code, a.balance, a.available])).toEqual([
      ['CASH-0001', 500, 300],
      ['CHQ-0001', 300, 0],
    ]);
    // Submitting posts nothing: the money stays in his accounts.
    expect(await h.balanceOf(vanCash)).toBe(500);
    await expect(submit(0, 1)).rejects.toThrow(/0.00 available/);
  });

  it('submits for another user only with select-collector', async () => {
    await receive(vanCash, 100);
    const other = await h.persistUser(makeUser('Van 2', [...VAN_SALESMAN_PERMISSIONS]));
    await expect(submit(100, 0, van, other.id)).rejects.toThrow('You can only record vouchers collected by yourself.');
    await expect(h.handovers.pending({ userId: other.id }, van)).rejects.toThrow(/collected by yourself/);
    const handover = await submit(100, 0, accountant, van.id);
    expect(handover.collectedById!.toString()).toBe(van.id);
    expect(handover.voucherNo).toBe('HO-0001');
  });

  it('approval moves exactly the received amounts; short leaves the rest pending', async () => {
    await receive(vanCash, 500);
    await receive(vanCheques, 300, 'CHQ 1001');
    const handover = await submit(500, 300);

    await expect(h.handovers.approve(id(handover), {}, van)).rejects.toThrow(/cannot approve/);
    await expect(submit(0, 0)).rejects.toThrow(/at least one amount/);

    const short = { lines: [{ sourceAccountId: vanCash.id as string, receivedAmount: 480 }] };
    await expect(h.handovers.approve(id(handover), short, accountant)).rejects.toThrow(/a reason is required/);
    await expect(
      h.handovers.approve(id(handover), { lines: [{ sourceAccountId: vanCash.id as string, receivedAmount: 501 }] }, accountant),
    ).rejects.toThrow(/more than the submitted/);

    const approved = await h.handovers.approve(id(handover), { ...short, reason: 'Short at count' }, accountant);
    expect(approved.status).toBe('approved');
    expect(approved.receivedTotal).toBe(780);
    expect(await h.balanceOf(vanCash)).toBe(20);
    expect(await h.balanceOf(vanCheques)).toBe(0);
    expect(await h.balanceOf(officeCash)).toBe(480);
    expect(await h.balanceOf(officeCheques)).toBe(300);
    expect((await pending()).totals).toEqual({ balance: 20, submitted: 0, available: 20 });
    await assertReconciled();
  });

  it('nobody approves their own handover', async () => {
    await receive(vanCash, 100);
    const handover = await submit(100, 0, accountant, van.id);
    await expect(h.handovers.approve(id(handover), {}, accountant)).rejects.toThrow(/someone else must approve/);
    await expect(h.handovers.reject(id(handover), { reason: 'Recount' }, accountant)).rejects.toThrow(/someone else/);
    await h.handovers.approve(id(handover), {}, admin);
  });

  it('reject and cancel restore the pending amount', async () => {
    await receive(vanCash, 500);
    const rejected = await submit(500, 0);
    await h.handovers.reject(id(rejected), { reason: 'Recount please' }, accountant);
    expect((await pending()).totals.available).toBe(500);

    const withdrawn = await submit(500, 0);
    await h.handovers.cancel(id(withdrawn), { reason: 'Submitted by mistake' }, van);
    expect((await pending()).totals.available).toBe(500);

    const approved = await submit(500, 0);
    await h.handovers.approve(id(approved), {}, accountant);
    await expect(h.handovers.cancel(id(approved), { reason: 'Wrong day' }, van)).rejects.toThrow(/cash-handovers:cancel/);
    await h.handovers.cancel(id(approved), { reason: 'Wrong day' }, admin);
    expect(await h.balanceOf(vanCash)).toBe(500);
    expect(await h.balanceOf(officeCash)).toBe(0);
    expect((await pending()).totals).toEqual({ balance: 500, submitted: 0, available: 500 });
    await assertReconciled();
  });

  it('blocks editing or cancelling a receipt whose money was already handed over', async () => {
    const receipt = await receive(vanCash, 500);
    await h.handovers.approve(id(await submit(500, 0)), {}, accountant);
    await expect(h.receipts.cancel(receipt.id as string, { reason: 'Duplicate' }, accountant)).rejects.toThrow(
      /already handed over/,
    );
    await expect(
      h.receipts.update(receipt.id as string, { lines: [{ accountId: customer.id as string, amount: 400 }] }, accountant),
    ).rejects.toThrow(/already handed over/);
    // Raising it is fine.
    await h.receipts.update(receipt.id as string, { lines: [{ accountId: customer.id as string, amount: 550 }] }, accountant);
    await assertReconciled();
  });

  it('lists only his own for a scoped user, prints the slip and audits every step', async () => {
    await receive(vanCash, 300);
    const mine = await submit(300, 0);
    const other = await h.persistUser({
      ...makeUser('Van 2', [...VAN_SALESMAN_PERMISSIONS]),
      allowedCashAccountIds: [officeCash.id as string],
    });
    await h.receipts.create(
      { voucherDate: '2026-10-01', cashAccountId: officeCash.id as string, lines: [{ accountId: customer.id as string, amount: 50 }] },
      other,
    );
    const theirs = await h.handovers.create({ lines: [{ sourceAccountId: officeCash.id as string, amount: 50 }] }, other);

    expect((await h.handovers.findAll({}, van)).items.map((row) => row.id)).toEqual([id(mine)]);
    await expect(h.handovers.findById(id(theirs), van)).rejects.toThrow(/not found/);

    await h.handovers.approve(id(mine), {}, accountant);
    const printed = await h.handovers.print(id(mine), van);
    expect(printed.filename).toBe('HO-0001.pdf');
    expect(JSON.stringify(printed.definition)).toContain('CASH HANDOVER SLIP');
    const actions = (await h.models.audit.find({ entityId: mine._id }).sort({ at: 1, _id: 1 }).lean().exec()).map(
      (entry) => (entry as unknown as { action: string }).action,
    );
    expect(actions).toEqual(['created', 'approved', 'printed']);
  });

  it('HTTP: a salesman reads his pending and cannot approve', async () => {
    await receive(vanCash, 100);
    const handover = await submit(100, 0);
    h.harness.tokenUser = van;
    const server = h.app.getHttpServer();
    const res = await request(server).get('/cash-handovers/pending');
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ balance: 100, submitted: 100, available: 0 });
    expect((await request(server).post(`/cash-handovers/${id(handover)}/approve`).send({})).status).toBe(403);
  });
});
