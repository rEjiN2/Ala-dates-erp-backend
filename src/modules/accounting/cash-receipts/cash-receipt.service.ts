import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, QueryFilter } from 'mongoose';
import {
  CashReceipt,
  CashReceiptDocument,
  CashReceiptLine,
} from './schemas/cash-receipt.schema.js';
import { CashReceiptLineDto, CreateCashReceiptDto } from './dto/create-cash-receipt.dto.js';
import { UpdateCashReceiptDto } from './dto/update-cash-receipt.dto.js';
import { CashReceiptQueryDto } from './dto/cash-receipt-query.dto.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../ledger-accounts/ledger-account-usage.registry.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import type { CodeSequence } from '../../sequence/code-sequence.js';
import { round2, sum2 } from '../../../common/utils/money.util.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

export const CASH_RECEIPT_VOUCHER_SEQUENCE: CodeSequence = { key: 'cash-receipt', prefix: 'CR', width: 6 };

interface PricedLine {
  accountId: string;
  narration?: string;
  remarks?: string;
  amount: number;
  vat: number;
  netAmount: number;
}

@Injectable()
export class CashReceiptService {
  constructor(
    @InjectModel(CashReceipt.name) private readonly cashReceiptModel: Model<CashReceiptDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly sequenceService: SequenceService,
    usageRegistry: LedgerAccountUsageRegistry,
  ) {
    // Blocks deleting an account any receipt posted to, on either side.
    usageRegistry.register('cash receipts', async (accountId, session) =>
      Boolean(
        await this.cashReceiptModel
          .exists({ $or: [{ cashAccountId: accountId }, { 'lines.accountId': accountId }] })
          .session(session ?? null)
          .exec(),
      ),
    );
  }

  async findAll(query: CashReceiptQueryDto = {}): Promise<CashReceiptDocument[]> {
    const filter: QueryFilter<CashReceiptDocument> = {};

    if (query.cashAccountId) {
      filter.cashAccountId = new Types.ObjectId(query.cashAccountId);
    }

    if (query.dateFrom || query.dateTo) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) {
        range.$gte = new Date(query.dateFrom);
      }
      if (query.dateTo) {
        range.$lte = this.endOfDayIfDateOnly(query.dateTo);
      }
      filter.voucherDate = range;
    }

    return this.cashReceiptModel.find(filter).sort({ voucherDate: -1, voucherNo: -1 }).exec();
  }

  async findById(id: string): Promise<CashReceiptDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Cash receipt id "${id}" is not a valid id`);
    }
    const receipt = await this.cashReceiptModel.findById(id).exec();
    if (!receipt) {
      throw new NotFoundException(`Cash receipt ${id} not found`);
    }
    return receipt;
  }

  async create(dto: CreateCashReceiptDto): Promise<CashReceiptDocument> {
    await this.ledgerAccountService.findActiveCashAccount(dto.cashAccountId);
    const pricedLines = this.priceLines(dto.lines);

    return this.withTransaction(async (session) => {
      const lines = await this.snapshotLines(pricedLines, session);
      // Issued on the transaction's session: if anything below aborts, the
      // counter increment rolls back too, so voucher numbers stay gapless.
      const voucherNo = await this.sequenceService.nextCode(CASH_RECEIPT_VOUCHER_SEQUENCE, session);

      const [created] = await this.cashReceiptModel.create(
        [
          {
            voucherNo,
            voucherDate: new Date(dto.voucherDate),
            cashAccountId: new Types.ObjectId(dto.cashAccountId),
            cashier: dto.cashier,
            comments: dto.comments,
            lines,
            ...this.totalsOf(pricedLines),
          },
        ],
        { session },
      );

      // Line accounts are verified here rather than up front: an unknown id makes
      // this throw, which aborts the transaction and unwinds the insert above.
      await this.ledgerAccountService.applyBalanceDeltas(
        this.buildDeltas(dto.cashAccountId, lines, 1),
        session,
      );

      return created;
    });
  }

  async update(id: string, dto: UpdateCashReceiptDto): Promise<CashReceiptDocument> {
    const existing = await this.findById(id);

    const nextCashAccountId = dto.cashAccountId ?? existing.cashAccountId.toString();
    await this.ledgerAccountService.findActiveCashAccount(nextCashAccountId);

    const pricedLines = dto.lines ? this.priceLines(dto.lines) : null;

    return this.withTransaction(async (session) => {
      // Unwind the original posting first, so a replacement line's oldBalance
      // snapshot reflects the balance as if this voucher had never been posted.
      await this.ledgerAccountService.applyBalanceDeltas(
        this.buildDeltas(existing.cashAccountId.toString(), existing.lines, -1),
        session,
      );

      const nextLines = pricedLines ? await this.snapshotLines(pricedLines, session) : existing.lines;

      if (dto.voucherDate !== undefined) existing.voucherDate = new Date(dto.voucherDate);
      if (dto.cashier !== undefined) existing.cashier = dto.cashier;
      if (dto.comments !== undefined) existing.comments = dto.comments;
      existing.cashAccountId = new Types.ObjectId(nextCashAccountId);
      existing.lines = nextLines;

      const totals = this.totalsOf(
        nextLines.map((line) => ({
          accountId: line.accountId.toString(),
          amount: line.amount,
          vat: line.vat,
          netAmount: line.netAmount,
        })),
      );
      existing.grossTotal = totals.grossTotal;
      existing.totalTax = totals.totalTax;
      existing.grandTotal = totals.grandTotal;

      await existing.save({ session });

      await this.ledgerAccountService.applyBalanceDeltas(
        this.buildDeltas(nextCashAccountId, nextLines, 1),
        session,
      );

      return existing;
    });
  }

  async remove(id: string): Promise<{ success: true }> {
    const existing = await this.findById(id);

    return this.withTransaction(async (session) => {
      await this.ledgerAccountService.applyBalanceDeltas(
        this.buildDeltas(existing.cashAccountId.toString(), existing.lines, -1),
        session,
      );
      await this.cashReceiptModel.deleteOne({ _id: existing._id }, { session }).exec();
      return { success: true as const };
    });
  }

  private priceLines(lines: readonly CashReceiptLineDto[]): PricedLine[] {
    return lines.map((line) => {
      const amount = round2(line.amount);
      const vat = round2(line.vat ?? 0);
      return {
        accountId: line.accountId,
        narration: line.narration,
        remarks: line.remarks,
        amount,
        vat,
        netAmount: round2(amount + vat),
      };
    });
  }

  private totalsOf(lines: readonly Pick<PricedLine, 'amount' | 'vat' | 'netAmount'>[]) {
    return {
      grossTotal: sum2(lines.map((line) => line.amount)),
      totalTax: sum2(lines.map((line) => line.vat)),
      grandTotal: sum2(lines.map((line) => line.netAmount)),
    };
  }

  private async snapshotLines(
    pricedLines: readonly PricedLine[],
    session: ClientSession,
  ): Promise<CashReceiptLine[]> {
    const balances = await this.ledgerAccountService.getBalances(
      pricedLines.map((line) => line.accountId),
      session,
    );

    return pricedLines.map((line) => ({
      accountId: new Types.ObjectId(line.accountId),
      narration: line.narration,
      remarks: line.remarks,
      oldBalance: balances.get(line.accountId) ?? 0,
      amount: line.amount,
      vat: line.vat,
      netAmount: line.netAmount,
    }));
  }

  /**
   * Cash in: the cash account gains the grand total, each line account is
   * relieved by its net amount. sign -1 reverses an existing posting.
   */
  private buildDeltas(
    cashAccountId: string,
    lines: readonly CashReceiptLine[],
    sign: 1 | -1,
  ): Map<string, number> {
    const deltas = new Map<string, number>();
    const accumulate = (accountId: string, delta: number) => {
      deltas.set(accountId, round2((deltas.get(accountId) ?? 0) + delta));
    };

    const grandTotal = sum2(lines.map((line) => line.netAmount));
    accumulate(cashAccountId, sign * grandTotal);

    for (const line of lines) {
      accumulate(line.accountId.toString(), sign * -line.netAmount);
    }

    return deltas;
  }

  private withTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    return runInTransaction(this.connection, work);
  }

  /** A date-only filter bound should cover the whole day, not just its midnight boundary. */
  private endOfDayIfDateOnly(value: string): Date {
    const date = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      date.setUTCHours(23, 59, 59, 999);
    }
    return date;
  }
}
