import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model, PipelineStage } from 'mongoose';
import { CashReceipt, CashReceiptDocument } from '../accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { CashHandover, CashHandoverDocument } from '../accounting/cash-handovers/schemas/cash-handover.schema.js';
import { PaymentMethod, VoucherStatus } from '../accounting/vouchers/schemas/voucher.schema.js';
import { LedgerAccountService } from '../accounting/ledger-accounts/ledger-account.service.js';
import { Cashier, CashierDocument } from '../cashier/schemas/cashier.schema.js';
import { Location, LocationDocument } from '../location/schemas/location.schema.js';
import { isOwnScope, type ScopedUser } from '../accounting/vouchers/data-scope.js';
import { round2, sum2 } from '../../common/utils/money.util.js';
import type { SalesmanCollectionDetailsQueryDto, SalesmanCollectionsQueryDto } from './dto/salesman-collections.dto.js';

type Ref = { id: string; name: string | null };

export interface SalesmanCollectionRow {
  cashier: { id: string; code: string; name: string; status: string; location: Ref | null };
  /** Cash collected minus cash handed over before dateFrom. */
  openingPending: number;
  /** Receipts into cash or wallet accounts in the range: the cash the cashier holds. */
  collectedCash: number;
  /** Receipts into bank accounts in the range: shown, never pending. */
  collectedBank: number;
  /** Handovers this cashier handed over in the range. */
  handedOver: number;
  /** openingPending + collectedCash - handedOver. */
  closingPending: number;
  /** Receipts in the range, cash and bank. */
  receiptCount: number;
  handoverCount: number;
}

type Totals = Omit<SalesmanCollectionRow, 'cashier'>;

export interface SalesmanCollectionsReport {
  dateFrom: string | null;
  dateTo: string | null;
  rows: SalesmanCollectionRow[];
  totals: Totals;
}

export interface SalesmanCollectionDetails {
  row: SalesmanCollectionRow;
  receipts: {
    id: string;
    voucherNo: string;
    date: Date;
    account: Ref;
    paymentMethod: PaymentMethod;
    amount: number;
    /** true for cash/wallet receipts (they count towards pending), false for bank. */
    countsAsPending: boolean;
  }[];
  handovers: {
    id: string;
    voucherNo: string;
    date: Date;
    fromAccount: Ref;
    toAccount: Ref | null;
    receivedBy: Ref;
    amount: number;
  }[];
}

interface Range {
  from: Date | null;
  to: Date | null;
}

const ZERO_TOTALS: Totals = {
  openingPending: 0,
  collectedCash: 0,
  collectedBank: 0,
  handedOver: 0,
  closingPending: 0,
  receiptCount: 0,
  handoverCount: 0,
};

/**
 * Cash a salesman (cashier) has collected and not yet handed over. Read
 * straight from the vouchers, cancelled ones excluded, so a cancel or an
 * edit shows up at once. Only receipts into cash or wallet accounts count as
 * cash held; bank receipts are listed but never pending. Handovers count for
 * the cashier who handed over (cashierId), on their voucher date.
 *
 * "own"-scoped users see only their linked cashier's row.
 */
@Injectable()
export class SalesmanCollectionsService {
  constructor(
    @InjectModel(CashReceipt.name) private readonly receiptModel: Model<CashReceiptDocument>,
    @InjectModel(CashHandover.name) private readonly handoverModel: Model<CashHandoverDocument>,
    @InjectModel(Cashier.name) private readonly cashierModel: Model<CashierDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    private readonly ledgerAccountService: LedgerAccountService,
  ) {}

  async report(query: SalesmanCollectionsQueryDto, viewer: ScopedUser): Promise<SalesmanCollectionsReport> {
    const range = this.rangeOf(query);
    const cashierIds = await this.allowedCashierIds(query, viewer);
    const rows = await this.rows(range, cashierIds, query.cashierId ? [query.cashierId] : []);
    return {
      dateFrom: query.dateFrom ?? null,
      dateTo: query.dateTo ?? null,
      rows,
      totals: this.totalsOf(rows),
    };
  }

  /** The receipts and handovers behind one row, in the range. Another cashier's row is 404 for a scoped user. */
  async details(
    cashierId: string,
    query: SalesmanCollectionDetailsQueryDto,
    viewer: ScopedUser,
  ): Promise<SalesmanCollectionDetails> {
    if (!Types.ObjectId.isValid(cashierId)) {
      throw new BadRequestException(`Cashier id "${cashierId}" is not a valid id`);
    }
    const allowed = await this.allowedCashierIds({ cashierId }, viewer);
    if (allowed?.length === 0 || !(await this.cashierModel.exists({ _id: cashierId }).exec())) {
      throw new NotFoundException(`Cashier ${cashierId} not found`);
    }
    const range = this.rangeOf(query);
    const [row] = await this.rows(range, [cashierId], [cashierId]);
    const id = new Types.ObjectId(cashierId);
    const inRange = this.dateFilter(range.from, range.to);
    const notCancelled = { status: { $ne: VoucherStatus.CANCELLED } };

    const [receipts, handovers] = await Promise.all([
      this.receiptModel
        .find({ cashierId: id, ...notCancelled, ...inRange })
        .sort({ voucherDate: 1, voucherNo: 1 })
        .lean()
        .exec(),
      this.handoverModel
        .find({ cashierId: id, ...notCancelled, ...inRange })
        .sort({ voucherDate: 1, voucherNo: 1 })
        .lean()
        .exec(),
    ]);
    const names = await this.ledgerAccountService.getNames([
      ...receipts.map((receipt) => receipt.cashAccountId.toString()),
      ...handovers.flatMap((handover) => [
        handover.fromAccountId.toString(),
        ...(handover.lines[0] ? [handover.lines[0].accountId.toString()] : []),
      ]),
    ]);
    const ref = (accountId: Types.ObjectId): Ref => ({
      id: accountId.toString(),
      name: names.get(accountId.toString()) ?? null,
    });

    return {
      row,
      receipts: receipts.map((receipt) => {
        const paymentMethod = receipt.paymentMethod ?? PaymentMethod.CASH;
        return {
          id: receipt._id.toString(),
          voucherNo: receipt.voucherNo,
          date: receipt.voucherDate,
          account: ref(receipt.cashAccountId),
          paymentMethod,
          amount: receipt.grandTotal,
          countsAsPending: paymentMethod !== PaymentMethod.BANK,
        };
      }),
      handovers: handovers.map((handover) => ({
        id: handover._id.toString(),
        voucherNo: handover.voucherNo,
        date: handover.voucherDate,
        fromAccount: ref(handover.fromAccountId),
        toAccount: handover.lines[0] ? ref(handover.lines[0].accountId) : null,
        receivedBy: { id: handover.receivedByCashierId.toString(), name: handover.receivedByCashierName },
        amount: handover.grandTotal,
      })),
    };
  }

  /**
   * One row per cashier with receipts or handovers up to the end of the
   * range (cashierIds null: any cashier). A row that is all zeros is left
   * out unless it was asked for by id.
   */
  private async rows(
    range: Range,
    cashierIds: string[] | null,
    alwaysInclude: string[],
  ): Promise<SalesmanCollectionRow[]> {
    if (cashierIds?.length === 0) {
      return [];
    }
    const match: Record<string, unknown> = {
      status: { $ne: VoucherStatus.CANCELLED },
      cashierId: cashierIds ? { $in: cashierIds.map((id) => new Types.ObjectId(id)) } : { $ne: null },
      ...this.dateFilter(null, range.to),
    };
    // Before the range counts towards the opening; in it, towards the movements.
    const before = range.from ? { $lt: ['$voucherDate', range.from] } : false;
    const during = range.from ? { $gte: ['$voucherDate', range.from] } : true;
    const isBank = { $eq: ['$paymentMethod', PaymentMethod.BANK] };
    const sumIf = (condition: unknown, value: unknown = '$grandTotal') => ({
      $sum: { $cond: [condition, value, 0] },
    });

    const receiptStages: PipelineStage[] = [
      { $match: match },
      {
        $group: {
          _id: '$cashierId',
          openingCash: sumIf({ $and: [before, { $not: [isBank] }] }),
          collectedCash: sumIf({ $and: [during, { $not: [isBank] }] }),
          collectedBank: sumIf({ $and: [during, isBank] }),
          receiptCount: sumIf(during, 1),
        },
      },
    ];
    const handoverStages: PipelineStage[] = [
      { $match: match },
      {
        $group: {
          _id: '$cashierId',
          openingHanded: sumIf(before),
          handedOver: sumIf(during),
          handoverCount: sumIf(during, 1),
        },
      },
    ];
    const [receiptRows, handoverRows] = await Promise.all([
      this.receiptModel
        .aggregate<{
          _id: Types.ObjectId;
          openingCash: number;
          collectedCash: number;
          collectedBank: number;
          receiptCount: number;
        }>(receiptStages)
        .exec(),
      this.handoverModel
        .aggregate<{ _id: Types.ObjectId; openingHanded: number; handedOver: number; handoverCount: number }>(
          handoverStages,
        )
        .exec(),
    ]);

    const receiptsBy = new Map(receiptRows.map((row) => [row._id.toString(), row]));
    const handoversBy = new Map(handoverRows.map((row) => [row._id.toString(), row]));
    const ids = [...new Set([...receiptsBy.keys(), ...handoversBy.keys(), ...alwaysInclude])];
    const cashiers = await this.cashierModel
      .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .select('code name status locationId')
      .lean()
      .exec();
    const locationIds = cashiers.flatMap((cashier) => (cashier.locationId ? [cashier.locationId] : []));
    const locations = await this.locationModel
      .find({ _id: { $in: locationIds } })
      .select('name')
      .lean()
      .exec();
    const locationName = new Map(locations.map((location) => [location._id.toString(), location.name]));

    return cashiers
      .map((cashier): SalesmanCollectionRow => {
        const id = cashier._id.toString();
        const receipts = receiptsBy.get(id);
        const handovers = handoversBy.get(id);
        const openingPending = round2((receipts?.openingCash ?? 0) - (handovers?.openingHanded ?? 0));
        const collectedCash = round2(receipts?.collectedCash ?? 0);
        const handedOver = round2(handovers?.handedOver ?? 0);
        return {
          cashier: {
            id,
            code: cashier.code,
            name: cashier.name,
            status: cashier.status,
            location: cashier.locationId
              ? { id: cashier.locationId.toString(), name: locationName.get(cashier.locationId.toString()) ?? null }
              : null,
          },
          openingPending,
          collectedCash,
          collectedBank: round2(receipts?.collectedBank ?? 0),
          handedOver,
          closingPending: round2(openingPending + collectedCash - handedOver),
          receiptCount: receipts?.receiptCount ?? 0,
          handoverCount: handovers?.handoverCount ?? 0,
        };
      })
      .filter(
        (row) =>
          alwaysInclude.includes(row.cashier.id) ||
          row.openingPending !== 0 ||
          row.closingPending !== 0 ||
          row.receiptCount > 0 ||
          row.handoverCount > 0,
      )
      .sort((a, b) => a.cashier.name.localeCompare(b.cashier.name));
  }

  /**
   * Cashiers the viewer may see that match the filters, or null for "any".
   * An "own"-scoped user is limited to their linked cashier (none: no rows).
   */
  private async allowedCashierIds(
    query: Pick<SalesmanCollectionsQueryDto, 'cashierId' | 'locationId'>,
    viewer: ScopedUser,
  ): Promise<string[] | null> {
    let ids: string[] | null = query.cashierId ? [query.cashierId] : null;
    if (isOwnScope(viewer)) {
      const own = await this.cashierModel.findOne({ linkedUserId: new Types.ObjectId(viewer.id) }).select('_id').exec();
      const ownId = own?._id.toString();
      ids = ownId && (!ids || ids.includes(ownId)) ? [ownId] : [];
    }
    if (query.locationId) {
      const atLocation = await this.cashierModel
        .find({ locationId: new Types.ObjectId(query.locationId), ...(ids ? { _id: { $in: ids } } : {}) })
        .select('_id')
        .lean()
        .exec();
      ids = atLocation.map((cashier) => cashier._id.toString());
    }
    return ids;
  }

  private rangeOf(query: { dateFrom?: string; dateTo?: string }): Range {
    const from = query.dateFrom ? new Date(query.dateFrom) : null;
    const to = query.dateTo ? this.endOfDayIfDateOnly(query.dateTo) : null;
    if (from && to && from > to) {
      throw new BadRequestException('dateFrom must not be after dateTo');
    }
    return { from, to };
  }

  private dateFilter(from: Date | null, to: Date | null): Record<string, unknown> {
    if (!from && !to) return {};
    return { voucherDate: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } };
  }

  private totalsOf(rows: readonly SalesmanCollectionRow[]): Totals {
    if (rows.length === 0) return { ...ZERO_TOTALS };
    const total = (key: keyof Totals) => sum2(rows.map((row) => row[key]));
    return {
      openingPending: total('openingPending'),
      collectedCash: total('collectedCash'),
      collectedBank: total('collectedBank'),
      handedOver: total('handedOver'),
      closingPending: total('closingPending'),
      receiptCount: rows.reduce((count, row) => count + row.receiptCount, 0),
      handoverCount: rows.reduce((count, row) => count + row.handoverCount, 0),
    };
  }

  /** A date-only bound covers the whole day, as on the voucher lists. */
  private endOfDayIfDateOnly(value: string): Date {
    const date = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      date.setUTCHours(23, 59, 59, 999);
    }
    return date;
  }
}
