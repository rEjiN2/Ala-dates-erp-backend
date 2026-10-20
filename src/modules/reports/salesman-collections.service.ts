import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model, PipelineStage } from 'mongoose';
import {
  CashReceipt,
  CashReceiptDocument,
  SettlementStatus,
} from '../accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { CashHandover, CashHandoverDocument } from '../accounting/cash-handovers/schemas/cash-handover.schema.js';
import { PaymentMethod, VoucherStatus } from '../accounting/vouchers/schemas/voucher.schema.js';
import { LedgerAccountService } from '../accounting/ledger-accounts/ledger-account.service.js';
import { Cashier, CashierDocument, StaffType } from '../cashier/schemas/cashier.schema.js';
import { Location, LocationDocument } from '../location/schemas/location.schema.js';
import { isOwnScope, type ScopedUser } from '../accounting/vouchers/data-scope.js';
import { round2, sum2 } from '../../common/utils/money.util.js';
import type { SalesmanCollectionDetailsQueryDto, SalesmanCollectionsQueryDto } from './dto/salesman-collections.dto.js';

type Ref = { id: string; name: string | null };

export interface SalesmanCollectionRow {
  cashier: { id: string; code: string; name: string; status: string; staffType: StaffType; location: Ref | null };
  /** Cash receipts dated before dateFrom and not settled by then. */
  unsettledOpening: number;
  /** Receipts into cash or wallet accounts in the range. */
  collectedCash: number;
  /** Receipts into bank accounts in the range: verified on handover, never unsettled cash. */
  collectedBank: number;
  /** Expected cash on submitted handovers (dated up to dateTo) awaiting approval. */
  pendingApproval: number;
  /** Cash received on handovers approved in the range. */
  settled: number;
  /** Expected minus received on handovers approved up to dateTo: still in the source (van) account. */
  openShortage: number;
  /** Cash receipts dated up to dateTo and not settled by then (pending approval included). */
  unsettledClosing: number;
  /** Receipts in the range, cash and bank. */
  receiptCount: number;
  /** Submitted or approved handovers dated in the range. */
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
    settlementStatus: SettlementStatus | null;
    handover: { id: string; voucherNo: string | null } | null;
  }[];
  handovers: {
    id: string;
    voucherNo: string;
    date: Date;
    status: VoucherStatus;
    sourceAccount: Ref;
    receivedInto: Ref | null;
    expectedCash: number;
    bankTotal: number;
    receivedCash: number | null;
    shortage: number;
    approvedAt: Date | null;
  }[];
}

interface Range {
  from: Date | null;
  to: Date | null;
}

const ZERO_TOTALS: Totals = {
  unsettledOpening: 0,
  collectedCash: 0,
  collectedBank: 0,
  pendingApproval: 0,
  settled: 0,
  openShortage: 0,
  unsettledClosing: 0,
  receiptCount: 0,
  handoverCount: 0,
};

/** Handover statuses that count: rejected and cancelled ones changed nothing. */
const LIVE_HANDOVER = [VoucherStatus.SUBMITTED, VoucherStatus.APPROVED];

/**
 * Cash collected by staff who settle with the office, and how it was
 * settled through handovers. Read straight from the receipts and handovers,
 * so a cancel, reject or approval shows at once. A receipt counts as
 * unsettled at a moment if it was not yet settled then (settledAt). Only
 * cash and wallet receipts are unsettled cash; bank ones are listed.
 *
 * "own"-scoped users see only their linked staff's row. Only staff with
 * settlesWithOffice appear (current flag); a details request for anyone else is 404.
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
    const staffId = query.staffId ?? query.cashierId;
    const cashierIds = await this.allowedCashierIds({ cashierId: staffId, locationId: query.locationId }, viewer);
    const rows = await this.rows(range, cashierIds, staffId ? [staffId] : []);
    return {
      dateFrom: query.dateFrom ?? null,
      dateTo: query.dateTo ?? null,
      rows,
      totals: this.totalsOf(rows),
    };
  }

  /** The receipts and handovers behind one row, in the range. Another staff member's row is 404 for a scoped user. */
  async details(
    cashierId: string,
    query: SalesmanCollectionDetailsQueryDto,
    viewer: ScopedUser,
  ): Promise<SalesmanCollectionDetails> {
    if (!Types.ObjectId.isValid(cashierId)) {
      throw new BadRequestException(`Staff id "${cashierId}" is not a valid id`);
    }
    const allowed = await this.allowedCashierIds({ cashierId }, viewer);
    if (
      allowed?.length === 0 ||
      !(await this.cashierModel.exists({ _id: cashierId, settlesWithOffice: true }).exec())
    ) {
      throw new NotFoundException(`Staff ${cashierId} not found`);
    }
    const range = this.rangeOf(query);
    const [row] = await this.rows(range, [cashierId], [cashierId]);
    const id = new Types.ObjectId(cashierId);
    const inRange = this.dateFilter(range.from, range.to);

    const [receipts, handovers] = await Promise.all([
      this.receiptModel
        .find({ cashierId: id, status: { $ne: VoucherStatus.CANCELLED }, settlementStatus: { $ne: null }, ...inRange })
        .sort({ voucherDate: 1, voucherNo: 1 })
        .lean()
        .exec(),
      this.handoverModel
        .find({ cashierId: id, ...inRange })
        .sort({ voucherDate: 1, voucherNo: 1 })
        .lean()
        .exec(),
    ]);
    const handoverIds = receipts.flatMap((receipt) => (receipt.handoverId ? [receipt.handoverId] : []));
    const handoverNos = new Map(
      (await this.handoverModel.find({ _id: { $in: handoverIds } }).select('voucherNo').lean().exec()).map((doc) => [
        doc._id.toString(),
        doc.voucherNo,
      ]),
    );
    const names = await this.ledgerAccountService.getNames([
      ...receipts.map((receipt) => receipt.cashAccountId.toString()),
      ...handovers.map((handover) => handover.fromAccountId.toString()),
    ]);
    const ref = (accountId: Types.ObjectId): Ref => ({
      id: accountId.toString(),
      name: names.get(accountId.toString()) ?? null,
    });

    return {
      row,
      receipts: receipts.map((receipt) => ({
        id: receipt._id.toString(),
        voucherNo: receipt.voucherNo,
        date: receipt.voucherDate,
        account: ref(receipt.cashAccountId),
        paymentMethod: receipt.paymentMethod ?? PaymentMethod.CASH,
        amount: receipt.grandTotal,
        settlementStatus: receipt.settlementStatus ?? null,
        handover: receipt.handoverId
          ? { id: receipt.handoverId.toString(), voucherNo: handoverNos.get(receipt.handoverId.toString()) ?? null }
          : null,
      })),
      handovers: handovers.map((handover) => ({
        id: handover._id.toString(),
        voucherNo: handover.voucherNo,
        date: handover.voucherDate,
        status: handover.status,
        sourceAccount: ref(handover.fromAccountId),
        receivedInto: handover.receivedIntoAccountId
          ? { id: handover.receivedIntoAccountId.toString(), name: handover.receivedIntoAccountName ?? null }
          : null,
        expectedCash: handover.expectedCash ?? 0,
        bankTotal: handover.bankTotal ?? 0,
        receivedCash: handover.receivedCash ?? null,
        shortage:
          handover.status === VoucherStatus.APPROVED
            ? round2((handover.expectedCash ?? 0) - (handover.receivedCash ?? 0))
            : 0,
        approvedAt: handover.approvedAt ?? null,
      })),
    };
  }

  /**
   * One row per settling staff member with receipts or handovers up to the
   * end of the range (cashierIds null: anyone). A row that is all zeros is
   * left out unless it was asked for by id.
   */
  private async rows(
    range: Range,
    cashierIds: string[] | null,
    alwaysInclude: string[],
  ): Promise<SalesmanCollectionRow[]> {
    if (cashierIds?.length === 0) {
      return [];
    }
    const cashierMatch = cashierIds ? { $in: cashierIds.map((id) => new Types.ObjectId(id)) } : { $ne: null };
    const and = (...conditions: unknown[]) => ({ $and: conditions });
    const sumIf = (condition: unknown, value: unknown = '$grandTotal') => ({ $sum: { $cond: [condition, value, 0] } });
    const during = and(
      range.from ? { $gte: ['$voucherDate', range.from] } : true,
      range.to ? { $lte: ['$voucherDate', range.to] } : true,
    );
    const isCash = { $ne: ['$paymentMethod', PaymentMethod.BANK] };
    // A missing settledAt is not equal to null in $expr, so normalise it first.
    const settledAt = { $ifNull: ['$settledAt', null] };
    const notSettledBy = (moment: Date | null, inclusive: boolean) =>
      moment
        ? { $or: [{ $eq: [settledAt, null] }, { [inclusive ? '$gte' : '$gt']: [settledAt, moment] }] }
        : { $eq: [settledAt, null] };

    const receiptStages: PipelineStage[] = [
      {
        $match: {
          cashierId: cashierMatch,
          status: { $ne: VoucherStatus.CANCELLED },
          settlementStatus: { $ne: null },
          ...this.dateFilter(null, range.to),
        },
      },
      {
        $group: {
          _id: '$cashierId',
          unsettledOpening: range.from
            ? sumIf(and(isCash, { $lt: ['$voucherDate', range.from] }, notSettledBy(range.from, true)))
            : { $sum: 0 },
          unsettledClosing: sumIf(and(isCash, notSettledBy(range.to, false))),
          collectedCash: sumIf(and(during, isCash)),
          collectedBank: sumIf(and(during, { $not: [isCash] })),
          receiptCount: sumIf(during, 1),
        },
      },
    ];

    // Handovers from before approval have no approvedAt: their voucher date stands in.
    const approvedAt = { $ifNull: ['$approvedAt', '$voucherDate'] };
    const isApproved = { $eq: ['$status', VoucherStatus.APPROVED] };
    const approvedBy = (moment: Date | null) => (moment ? { $lte: [approvedAt, moment] } : true);
    const handoverStages: PipelineStage[] = [
      { $match: { cashierId: cashierMatch, status: { $in: LIVE_HANDOVER } } },
      {
        $group: {
          _id: '$cashierId',
          pendingApproval: sumIf(
            and({ $eq: ['$status', VoucherStatus.SUBMITTED] }, range.to ? { $lte: ['$voucherDate', range.to] } : true),
            '$expectedCash',
          ),
          settled: sumIf(
            and(isApproved, range.from ? { $gte: [approvedAt, range.from] } : true, approvedBy(range.to)),
            { $ifNull: ['$receivedCash', 0] },
          ),
          openShortage: sumIf(and(isApproved, approvedBy(range.to)), {
            $subtract: [{ $ifNull: ['$expectedCash', 0] }, { $ifNull: ['$receivedCash', 0] }],
          }),
          handoverCount: sumIf(during, 1),
        },
      },
    ];

    type ReceiptGroup = Pick<
      Totals,
      'unsettledOpening' | 'unsettledClosing' | 'collectedCash' | 'collectedBank' | 'receiptCount'
    > & { _id: Types.ObjectId };
    type HandoverGroup = Pick<Totals, 'pendingApproval' | 'settled' | 'openShortage' | 'handoverCount'> & {
      _id: Types.ObjectId;
    };
    const [receiptRows, handoverRows] = await Promise.all([
      this.receiptModel.aggregate<ReceiptGroup>(receiptStages).exec(),
      this.handoverModel.aggregate<HandoverGroup>(handoverStages).exec(),
    ]);

    const receiptsBy = new Map(receiptRows.map((row) => [row._id.toString(), row]));
    const handoversBy = new Map(handoverRows.map((row) => [row._id.toString(), row]));
    const ids = [...new Set([...receiptsBy.keys(), ...handoversBy.keys(), ...alwaysInclude])];
    const cashiers = await this.cashierModel
      .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, settlesWithOffice: true })
      .select('code name status staffType locationId')
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
        return {
          cashier: {
            id,
            code: cashier.code,
            name: cashier.name,
            status: cashier.status,
            staffType: cashier.staffType ?? StaffType.CASHIER,
            location: cashier.locationId
              ? { id: cashier.locationId.toString(), name: locationName.get(cashier.locationId.toString()) ?? null }
              : null,
          },
          unsettledOpening: round2(receipts?.unsettledOpening ?? 0),
          collectedCash: round2(receipts?.collectedCash ?? 0),
          collectedBank: round2(receipts?.collectedBank ?? 0),
          pendingApproval: round2(handovers?.pendingApproval ?? 0),
          settled: round2(handovers?.settled ?? 0),
          openShortage: round2(handovers?.openShortage ?? 0),
          unsettledClosing: round2(receipts?.unsettledClosing ?? 0),
          receiptCount: receipts?.receiptCount ?? 0,
          handoverCount: handovers?.handoverCount ?? 0,
        };
      })
      .filter(
        (row) =>
          alwaysInclude.includes(row.cashier.id) ||
          row.receiptCount > 0 ||
          row.handoverCount > 0 ||
          (Object.keys(ZERO_TOTALS) as (keyof Totals)[]).some((key) => row[key] !== 0),
      )
      .sort((a, b) => a.cashier.name.localeCompare(b.cashier.name));
  }

  /**
   * Staff the viewer may see that match the filters, or null for "any".
   * An "own"-scoped user is limited to their linked staff record (none: no rows).
   */
  private async allowedCashierIds(
    query: { cashierId?: string; locationId?: string },
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
      unsettledOpening: total('unsettledOpening'),
      collectedCash: total('collectedCash'),
      collectedBank: total('collectedBank'),
      pendingApproval: total('pendingApproval'),
      settled: total('settled'),
      openShortage: total('openShortage'),
      unsettledClosing: total('unsettledClosing'),
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
