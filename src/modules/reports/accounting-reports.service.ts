import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { LedgerEntry, LedgerEntryDocument, LedgerEntryKind } from '../accounting/vouchers/schemas/ledger-entry.schema.js';
import {
  LedgerAccount,
  LedgerAccountDocument,
  LedgerAccountType,
} from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { round2, sum2 } from '../../common/utils/money.util.js';
import { pageOf, ReportService } from './report.service.js';
import type {
  CashBookQueryDto,
  DayBookQueryDto,
  LedgerReportQueryDto,
  TrialBalanceQueryDto,
} from './dto/accounting-reports.dto.js';

/** Voucher type (ledger_entries.voucherType) -> its collection, for status and "created by". */
const VOUCHER_COLLECTIONS: Record<string, string> = {
  'cash-receipt': 'cash_receipts',
  'cash-payment': 'cash_payments',
  'cash-handover': 'handovers',
  'sales-invoice': 'sales_invoices',
  'purchase-invoice': 'purchase_invoices',
  'sales-return': 'sales_returns',
  'purchase-return': 'purchase_returns',
  'opening-balance': 'opening_balances',
};

const BOOK_TYPES = [LedgerAccountType.CASH, LedgerAccountType.WALLET, LedgerAccountType.CHEQUE, LedgerAccountType.BANK];

const day = (date: Date) => date.toISOString().slice(0, 10);
const subtitleOf = (query: { dateFrom?: string | null; dateTo?: string | null }) =>
  `${query.dateFrom ?? 'Beginning'} to ${query.dateTo ?? 'today'}`;

/** Ledger, day book, cash and bank book, trial balance: all read from ledger_entries. */
@Injectable()
export class AccountingReportsService {
  constructor(
    @InjectModel(LedgerEntry.name) private readonly entryModel: Model<LedgerEntryDocument>,
    @InjectModel(LedgerAccount.name) private readonly accountModel: Model<LedgerAccountDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly reports: ReportService,
  ) {}

  /** Statement of account for any account, customers and suppliers included. */
  async ledger(query: LedgerReportQueryDto): Promise<object | StreamableFile> {
    const account = await this.accountModel.findById(query.accountId).select('code name type').lean().exec();
    if (!account) throw new NotFoundException(`Account ${query.accountId} not found`);
    const range = this.reports.rangeOf(query);
    const accountId = account._id;
    const cancelled = new Set((await this.reports.cancelledVoucherIds(range, { accountId })).map(String));
    const match: Record<string, unknown> = { accountId, ...this.reports.dateFilter(range) };
    if (!query.includeCancelled && cancelled.size > 0) {
      match.voucherId = { $nin: [...cancelled].map((id) => new Types.ObjectId(id)) };
    }
    const opening = await this.reports.openingBalance({ accountId }, range.from);
    const paging = query.format ? null : pageOf(query);

    const [result] = await this.entryModel
      .aggregate<{ rows: Record<string, unknown>[]; totals: { debit: number; credit: number; count: number }[] }>([
        { $match: match },
        {
          $setWindowFields: {
            sortBy: ReportService.ORDER,
            output: {
              running: {
                $sum: { $subtract: ['$debit', '$credit'] },
                window: { documents: ['unbounded', 'current'] },
              },
            },
          },
        },
        { $sort: ReportService.ORDER },
        {
          $facet: {
            rows: paging ? [{ $skip: paging.skip }, { $limit: paging.limit }] : [{ $match: {} }],
            totals: [{ $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' }, count: { $sum: 1 } } }],
          },
        },
      ])
      .exec();
    const totals = result?.totals[0] ?? { debit: 0, credit: 0, count: 0 };
    const rows = (result?.rows ?? []).map((row) => {
      const voucherId = (row.voucherId as Types.ObjectId).toString();
      return {
        date: day(row.voucherDate as Date),
        voucherType: row.voucherType as string,
        voucherNo: row.voucherNo as string,
        voucherId,
        narration: (row.narration as string | null) ?? null,
        debit: row.debit as number,
        credit: row.credit as number,
        runningBalance: round2(opening + (row.running as number)),
        ...(query.includeCancelled
          ? { cancelled: cancelled.has(voucherId), reversal: row.kind === LedgerEntryKind.REVERSAL }
          : {}),
      };
    });
    const debit = round2(totals.debit);
    const credit = round2(totals.credit);
    const closing = round2(opening + debit - credit);
    const report = {
      account: { id: accountId.toString(), code: account.code, name: account.name, type: account.type },
      dateFrom: query.dateFrom ?? null,
      dateTo: query.dateTo ?? null,
      opening,
      rows,
      totals: { debit, credit },
      closing,
      page: paging?.page ?? 1,
      total: totals.count,
    };
    if (!query.format) return report;
    return this.reports.export(
      {
        title: 'Ledger',
        subtitle: `${account.code} ${account.name}  |  ${subtitleOf(query)}`,
        columns: [
          { key: 'date', label: 'Date' },
          { key: 'voucherType', label: 'Type' },
          { key: 'voucherNo', label: 'No' },
          { key: 'narration', label: 'Narration' },
          { key: 'debit', label: 'Debit', money: true },
          { key: 'credit', label: 'Credit', money: true },
          { key: 'runningBalance', label: 'Balance', money: true },
        ],
        rows: [
          { narration: 'Opening balance', runningBalance: opening },
          ...rows,
          { narration: 'Total / Closing', debit, credit, runningBalance: closing },
        ],
      },
      query.format,
    );
  }

  /** One row per voucher across all voucher types. */
  async dayBook(query: DayBookQueryDto): Promise<object | StreamableFile> {
    const range = this.reports.rangeOf(query);
    const cancelled = new Set((await this.reports.cancelledVoucherIds(range)).map(String));
    const entries = await this.entryModel
      .find({
        ...this.reports.dateFilter(range),
        ...(query.voucherTypes?.length ? { voucherType: { $in: query.voucherTypes } } : {}),
      })
      .sort(ReportService.ORDER)
      .select('accountId voucherType voucherId voucherNo voucherDate debit kind postedAt')
      .lean()
      .exec();

    interface Voucher {
      type: string;
      no: string;
      id: string;
      date: Date;
      accounts: Set<string>;
      /** Postings minus reversals: 0 once cancelled. */
      live: number;
      /** What the last posting carried, shown for cancelled vouchers. */
      lastPosting: number;
      lastAt: number;
    }
    const vouchers = new Map<string, Voucher>();
    for (const entry of entries) {
      const key = entry.voucherId.toString();
      const voucher = vouchers.get(key) ?? {
        type: entry.voucherType,
        no: entry.voucherNo,
        id: key,
        date: entry.voucherDate,
        accounts: new Set<string>(),
        live: 0,
        lastPosting: 0,
        lastAt: 0,
      };
      voucher.accounts.add(entry.accountId.toString());
      if (entry.kind === LedgerEntryKind.POSTING) {
        voucher.live += entry.debit;
        const at = entry.postedAt.getTime();
        if (at > voucher.lastAt) [voucher.lastAt, voucher.lastPosting] = [at, 0];
        if (at === voucher.lastAt) voucher.lastPosting += entry.debit;
      } else {
        voucher.live -= entry.debit;
      }
      vouchers.set(key, voucher);
    }

    const list = [...vouchers.values()];
    const meta = await this.voucherMeta(list);
    const accounts = await this.accountModel
      .find({ _id: { $in: [...new Set(list.flatMap((voucher) => [...voucher.accounts]))] } })
      .select('name type')
      .lean()
      .exec();
    const accountOf = new Map(accounts.map((account) => [account._id.toString(), account]));

    const rows = list
      .map((voucher) => {
        const info = meta.get(voucher.id);
        const isCancelled = cancelled.has(voucher.id);
        const named = [...voucher.accounts].flatMap((id) => accountOf.get(id) ?? []);
        const parties = named.filter((a) => a.type === LedgerAccountType.PARTY || a.type === LedgerAccountType.SUPPLIER);
        const shown = (parties.length ? parties : named).map((a) => a.name);
        return {
          date: day(voucher.date),
          type: info?.receiptKind === 'reference' ? 'reference-receipt' : voucher.type,
          no: voucher.no,
          voucherId: voucher.id,
          summary: shown.length > 3 ? `${shown.slice(0, 3).join(', ')} +${shown.length - 3}` : shown.join(', '),
          amount: round2(isCancelled ? voucher.lastPosting : voucher.live),
          status: isCancelled ? 'cancelled' : (info?.status ?? 'posted'),
          createdBy: info?.createdBy ?? null,
        };
      })
      .filter(
        (row) =>
          (query.includeCancelled || row.status !== 'cancelled') && (!query.userId || row.createdBy?.id === query.userId),
      )
      .sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no));

    const byType = new Map<string, number[]>();
    for (const row of rows) {
      if (row.status !== 'cancelled') byType.set(row.type, [...(byType.get(row.type) ?? []), row.amount]);
    }
    const totals = [...byType].map(([type, amounts]) => ({ type, count: amounts.length, amount: sum2(amounts) }));

    const paging = query.format ? null : pageOf(query);
    if (!query.format) {
      return {
        dateFrom: query.dateFrom ?? null,
        dateTo: query.dateTo ?? null,
        rows: rows.slice(paging!.skip, paging!.skip + paging!.limit),
        totals,
        page: paging!.page,
        total: rows.length,
      };
    }
    return this.reports.export(
      {
        title: 'Day Book',
        subtitle: subtitleOf(query),
        columns: [
          { key: 'date', label: 'Date' },
          { key: 'type', label: 'Type' },
          { key: 'no', label: 'No' },
          { key: 'summary', label: 'Party / Accounts' },
          { key: 'amount', label: 'Amount', money: true },
          { key: 'status', label: 'Status' },
          { key: 'createdByName', label: 'Created By' },
        ],
        rows: rows.map((row) => ({ ...row, createdByName: row.createdBy?.name ?? '' })),
      },
      query.format,
    );
  }

  /** Daily opening / receipts (debits) / payments (credits) / closing over the chosen cash-like and bank accounts. */
  async cashBook(query: CashBookQueryDto): Promise<object | StreamableFile> {
    const range = this.reports.rangeOf(query);
    const accounts = await this.accountModel
      .find(
        query.accountIds?.length
          ? { _id: { $in: query.accountIds.map((id) => new Types.ObjectId(id)) } }
          : { type: { $in: BOOK_TYPES } },
      )
      .select('code name type')
      .sort({ code: 1 })
      .lean()
      .exec();
    const accountIds = accounts.map((account) => account._id);
    const cancelled = new Set(
      (await this.reports.cancelledVoucherIds(range, { accountId: { $in: accountIds } })).map(String),
    );
    const opening = await this.reports.openingBalance({ accountId: { $in: accountIds } }, range.from);
    const entries = (
      await this.entryModel
        .find({ accountId: { $in: accountIds }, ...this.reports.dateFilter(range) })
        .sort(ReportService.ORDER)
        .lean()
        .exec()
    ).filter((entry) => query.includeCancelled || !cancelled.has(entry.voucherId.toString()));

    const nameOf = new Map(accounts.map((account) => [account._id.toString(), account.name]));
    const details = entries.map((entry) => ({
      date: day(entry.voucherDate),
      account: nameOf.get(entry.accountId.toString()) ?? '',
      voucherType: entry.voucherType,
      voucherNo: entry.voucherNo,
      narration: entry.narration,
      debit: entry.debit,
      credit: entry.credit,
      ...(query.includeCancelled ? { cancelled: cancelled.has(entry.voucherId.toString()) } : {}),
    }));

    const days = new Map<string, { receipts: number[]; payments: number[] }>();
    for (const row of details) {
      const bucket = days.get(row.date) ?? { receipts: [], payments: [] };
      bucket.receipts.push(row.debit);
      bucket.payments.push(row.credit);
      days.set(row.date, bucket);
    }
    let running = opening;
    const daily = [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bucket]) => {
        const dayOpening = running;
        const receipts = sum2(bucket.receipts);
        const payments = sum2(bucket.payments);
        running = round2(dayOpening + receipts - payments);
        return { date, opening: dayOpening, receipts, payments, closing: running };
      });

    if (!query.format) {
      return {
        accounts: accounts.map((a) => ({ id: a._id.toString(), code: a.code, name: a.name, type: a.type })),
        dateFrom: query.dateFrom ?? null,
        dateTo: query.dateTo ?? null,
        opening,
        daily,
        details,
        closing: running,
      };
    }
    return this.reports.export(
      {
        title: 'Cash and Bank Book',
        subtitle: subtitleOf(query),
        columns: [
          { key: 'date', label: 'Date' },
          { key: 'opening', label: 'Opening', money: true },
          { key: 'receipts', label: 'Receipts', money: true },
          { key: 'payments', label: 'Payments', money: true },
          { key: 'closing', label: 'Closing', money: true },
        ],
        rows: daily,
      },
      query.format,
    );
  }

  /** Closing balance per account as of a date: positive in Debit, negative in Credit. */
  async trialBalance(query: TrialBalanceQueryDto): Promise<object | StreamableFile> {
    const asOf = query.asOf ? this.reports.endOfDay(query.asOf) : new Date();
    const balances = await this.entryModel
      .aggregate<{ _id: Types.ObjectId; net: number }>([
        { $match: { voucherDate: { $lte: asOf } } },
        { $group: { _id: '$accountId', net: { $sum: { $subtract: ['$debit', '$credit'] } } } },
      ])
      .exec();
    const accounts = await this.accountModel
      .find({ _id: { $in: balances.map((b) => b._id) } })
      .select('code name type')
      .sort({ code: 1 })
      .lean()
      .exec();
    const netOf = new Map(balances.map((b) => [b._id.toString(), round2(b.net)]));

    type Line = { code: string; name: string; type: string; debit: number; credit: number };
    const groups = new Map<string, Line[]>();
    for (const account of accounts) {
      const net = netOf.get(account._id.toString()) ?? 0;
      if (net === 0) continue;
      groups.set(account.type, [
        ...(groups.get(account.type) ?? []),
        { code: account.code, name: account.name, type: account.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 },
      ]);
    }
    const grouped = [...groups].map(([type, lines]) => ({
      type,
      accounts: lines,
      debit: sum2(lines.map((line) => line.debit)),
      credit: sum2(lines.map((line) => line.credit)),
    }));
    const totals = { debit: sum2(grouped.map((g) => g.debit)), credit: sum2(grouped.map((g) => g.credit)) };
    const report = { asOf: day(asOf), groups: grouped, totals };
    if (!query.format) return report;
    return this.reports.export(
      {
        title: 'Trial Balance',
        subtitle: `As of ${report.asOf}`,
        columns: [
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Account' },
          { key: 'type', label: 'Type' },
          { key: 'debit', label: 'Debit', money: true },
          { key: 'credit', label: 'Credit', money: true },
        ],
        rows: [...grouped.flatMap((g) => g.accounts), { code: '', name: 'Total', type: '', ...totals }],
      },
      query.format,
    );
  }

  /** status and createdBy of each voucher, one query per voucher type. */
  private async voucherMeta(vouchers: { type: string; id: string }[]) {
    const byType = new Map<string, Types.ObjectId[]>();
    for (const { type, id } of vouchers) byType.set(type, [...(byType.get(type) ?? []), new Types.ObjectId(id)]);
    const meta = new Map<
      string,
      { status: string; createdBy: { id: string; name: string } | null; receiptKind?: string }
    >();
    for (const [type, ids] of byType) {
      const collection = VOUCHER_COLLECTIONS[type];
      if (!collection) continue;
      const docs = await this.connection
        .collection<{
          _id: Types.ObjectId;
          status?: string;
          receiptKind?: string;
          createdBy?: { id: Types.ObjectId; name: string } | null;
        }>(collection)
        .find({ _id: { $in: ids } }, { projection: { status: 1, createdBy: 1, receiptKind: 1 } })
        .toArray();
      for (const doc of docs) {
        meta.set(doc._id.toString(), {
          receiptKind: doc.receiptKind,
          status: doc.status ?? 'posted',
          createdBy: doc.createdBy ? { id: doc.createdBy.id.toString(), name: doc.createdBy.name } : null,
        });
      }
    }
    return meta;
  }
}
