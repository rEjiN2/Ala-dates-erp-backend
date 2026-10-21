import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model, PipelineStage } from 'mongoose';
import { CashReceipt, CashReceiptDocument } from '../accounting/cash-receipts/schemas/cash-receipt.schema.js';
import { CashHandover, CashHandoverDocument } from '../accounting/cash-handovers/schemas/cash-handover.schema.js';
import { PaymentMethod, VoucherStatus } from '../accounting/vouchers/schemas/voucher.schema.js';
import { CASH_LIKE_ACCOUNT_TYPES, LedgerAccountService } from '../accounting/ledger-accounts/ledger-account.service.js';
import { User, UserDocument, UserStatus, isUserActive } from '../users/schemas/user.schema.js';
import { Location, LocationDocument } from '../location/schemas/location.schema.js';
import { isOwnScope, type ScopedUser } from '../accounting/vouchers/data-scope.js';
import { round2, sum2 } from '../../common/utils/money.util.js';
import type { SalesmanCollectionDetailsQueryDto, SalesmanCollectionsQueryDto } from './dto/salesman-collections.dto.js';

type Ref = { id: string; name: string | null };

export interface SalesmanCollectionRow {
  staff: { id: string; name: string; status: UserStatus; location: Ref | null };
  /** Receipts in the range (cancelled excluded). */
  receipts: number;
  /** Into cash or wallet accounts. */
  collectedCash: number;
  /** Into cheque accounts. */
  collectedCheque: number;
  /** Into bank accounts. */
  collectedBank: number;
  /** Cash + cheque + bank: matches the receipts list total for the same dates and collector. */
  total: number;
  /** Received on handovers approved in the range. */
  handedOver: number;
  /** Submitted on handovers awaiting approval now. */
  pendingApproval: number;
  /** Current balance of the user's own cash, wallet and cheque accounts. */
  withSalesman: number;
}

type Totals = Omit<SalesmanCollectionRow, 'staff'>;

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
    paymentReference: string | null;
    amount: number;
  }[];
  handovers: {
    id: string;
    voucherNo: string;
    date: Date;
    status: VoucherStatus;
    submittedTotal: number;
    receivedTotal: number | null;
    approvedAt: Date | null;
  }[];
}

interface Range {
  from: Date | null;
  to: Date | null;
}

const ZERO_TOTALS: Totals = {
  receipts: 0,
  collectedCash: 0,
  collectedCheque: 0,
  collectedBank: 0,
  total: 0,
  handedOver: 0,
  pendingApproval: 0,
  withSalesman: 0,
};

/**
 * Per user: receipts they collected in the range (cancelled excluded), split
 * by how the money came in, what they handed over (approved in the range),
 * what awaits approval now and what they hold now (their own cash, wallet and
 * cheque balances). Every number defaults to 0.
 *
 * "own"-scoped users see only their own row; a details request for anyone else is 404.
 */
@Injectable()
export class SalesmanCollectionsService {
  constructor(
    @InjectModel(CashReceipt.name) private readonly receiptModel: Model<CashReceiptDocument>,
    @InjectModel(CashHandover.name) private readonly handoverModel: Model<CashHandoverDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    private readonly ledgerAccountService: LedgerAccountService,
  ) {}

  async report(query: SalesmanCollectionsQueryDto, viewer: ScopedUser): Promise<SalesmanCollectionsReport> {
    const range = this.rangeOf(query);
    const staffId = query.userId ?? query.staffId;
    const staffIds = await this.allowedStaffIds({ staffId, locationId: query.locationId }, viewer);
    const rows = await this.rows(range, staffIds, staffId ? [staffId] : []);
    return {
      dateFrom: query.dateFrom ?? null,
      dateTo: query.dateTo ?? null,
      rows,
      totals: this.totalsOf(rows),
    };
  }

  /** The receipts and handovers behind one row, in the range. Another user's row is 404 for a scoped user. */
  async details(
    staffId: string,
    query: SalesmanCollectionDetailsQueryDto,
    viewer: ScopedUser,
  ): Promise<SalesmanCollectionDetails> {
    if (!Types.ObjectId.isValid(staffId)) {
      throw new BadRequestException(`Staff id "${staffId}" is not a valid id`);
    }
    const allowed = await this.allowedStaffIds({ staffId }, viewer);
    if (allowed?.length === 0 || !(await this.userModel.exists({ _id: staffId }).exec())) {
      throw new NotFoundException(`Staff ${staffId} not found`);
    }
    const range = this.rangeOf(query);
    const [row] = await this.rows(range, [staffId], [staffId]);
    const id = new Types.ObjectId(staffId);
    const inRange = this.dateFilter(range.from, range.to);
    const [receipts, handovers] = await Promise.all([
      this.receiptModel
        .find({ collectedById: id, status: { $ne: VoucherStatus.CANCELLED }, ...inRange })
        .sort({ voucherDate: 1, voucherNo: 1 })
        .lean()
        .exec(),
      this.handoverModel
        .find({ collectedById: id, ...inRange })
        .sort({ voucherDate: 1, voucherNo: 1 })
        .lean()
        .exec(),
    ]);
    const names = await this.ledgerAccountService.getNames(receipts.map((receipt) => receipt.cashAccountId.toString()));

    return {
      row,
      receipts: receipts.map((receipt) => ({
        id: receipt._id.toString(),
        voucherNo: receipt.voucherNo,
        date: receipt.voucherDate,
        account: {
          id: receipt.cashAccountId.toString(),
          name: names.get(receipt.cashAccountId.toString()) ?? null,
        },
        paymentMethod: receipt.paymentMethod ?? PaymentMethod.CASH,
        paymentReference: receipt.paymentReference ?? null,
        amount: receipt.grandTotal,
      })),
      handovers: handovers.map((handover) => ({
        id: handover._id.toString(),
        voucherNo: handover.voucherNo,
        date: handover.voucherDate,
        status: handover.status,
        submittedTotal: handover.submittedTotal ?? 0,
        receivedTotal: handover.receivedTotal ?? null,
        approvedAt: handover.approvedAt ?? null,
      })),
    };
  }

  /**
   * One row per user with receipts or handovers, or holding money in their own
   * accounts (staffIds null: anyone). An all-zero row is left out unless asked for by id.
   */
  private async rows(
    range: Range,
    staffIds: string[] | null,
    alwaysInclude: string[],
  ): Promise<SalesmanCollectionRow[]> {
    if (staffIds?.length === 0) {
      return [];
    }
    const staffMatch = staffIds ? { $in: staffIds.map((id) => new Types.ObjectId(id)) } : { $ne: null };
    const sumIf = (condition: unknown, value: unknown = '$grandTotal') => ({ $sum: { $cond: [condition, value, 0] } });
    const methodIs = (method: PaymentMethod) => ({ $eq: ['$paymentMethod', method] });

    const receiptStages: PipelineStage[] = [
      {
        $match: {
          collectedById: staffMatch,
          status: { $ne: VoucherStatus.CANCELLED },
          ...this.dateFilter(range.from, range.to),
        },
      },
      {
        $group: {
          _id: '$collectedById',
          receipts: { $sum: 1 },
          collectedCheque: sumIf(methodIs(PaymentMethod.CHEQUE)),
          collectedBank: sumIf(methodIs(PaymentMethod.BANK)),
          // Vouchers from before bank support have no method and count as cash.
          collectedCash: sumIf({ $not: [{ $in: ['$paymentMethod', [PaymentMethod.CHEQUE, PaymentMethod.BANK]] }] }),
        },
      },
    ];
    const approvedInRange = {
      $and: [
        { $eq: ['$status', VoucherStatus.APPROVED] },
        range.from ? { $gte: ['$approvedAt', range.from] } : true,
        range.to ? { $lte: ['$approvedAt', range.to] } : true,
      ],
    };
    const handoverStages: PipelineStage[] = [
      { $match: { collectedById: staffMatch, status: { $in: [VoucherStatus.SUBMITTED, VoucherStatus.APPROVED] } } },
      {
        $group: {
          _id: '$collectedById',
          handedOver: sumIf(approvedInRange, { $ifNull: ['$receivedTotal', 0] }),
          pendingApproval: sumIf({ $eq: ['$status', VoucherStatus.SUBMITTED] }, '$submittedTotal'),
        },
      },
    ];

    type ReceiptGroup = Pick<Totals, 'receipts' | 'collectedCash' | 'collectedCheque' | 'collectedBank'> & {
      _id: Types.ObjectId;
    };
    type HandoverGroup = Pick<Totals, 'handedOver' | 'pendingApproval'> & { _id: Types.ObjectId };
    const [receiptRows, handoverRows] = await Promise.all([
      this.receiptModel.aggregate<ReceiptGroup>(receiptStages).exec(),
      this.handoverModel.aggregate<HandoverGroup>(handoverStages).exec(),
    ]);
    const receiptsBy = new Map(receiptRows.map((row) => [row._id.toString(), row]));
    const handoversBy = new Map(handoverRows.map((row) => [row._id.toString(), row]));
    const active = [...new Set([...receiptsBy.keys(), ...handoversBy.keys(), ...alwaysInclude])].map(
      (id) => new Types.ObjectId(id),
    );

    // Anyone holding own accounts may have money with them, even with no activity.
    const users = await this.userModel
      .find(
        staffIds
          ? { _id: { $in: staffIds.map((id) => new Types.ObjectId(id)) } }
          : { $or: [{ _id: { $in: active } }, { 'allowedCashAccountIds.0': { $exists: true } }] },
      )
      .select('name status isActive locationId allowedCashAccountIds')
      .lean()
      .exec();
    const accountIds = [...new Set(users.flatMap((user) => (user.allowedCashAccountIds ?? []).map(String)))];
    const [summaries, balances, locations] = await Promise.all([
      this.ledgerAccountService.getSummaries(accountIds),
      this.ledgerAccountService.getBalances(accountIds),
      this.locationModel
        .find({ _id: { $in: users.flatMap((user) => (user.locationId ? [user.locationId] : [])) } })
        .select('name')
        .lean()
        .exec(),
    ]);
    const locationName = new Map(locations.map((location) => [location._id.toString(), location.name]));
    const holding = (user: (typeof users)[number]) =>
      sum2(
        (user.allowedCashAccountIds ?? [])
          .map(String)
          .filter((accountId) => {
            const type = summaries.get(accountId)?.type;
            return type !== undefined && CASH_LIKE_ACCOUNT_TYPES.includes(type);
          })
          .map((accountId) => balances.get(accountId) ?? 0),
      );

    return users
      .map((user): SalesmanCollectionRow => {
        const id = user._id.toString();
        const receipts = receiptsBy.get(id);
        const handovers = handoversBy.get(id);
        const collectedCash = round2(receipts?.collectedCash ?? 0);
        const collectedCheque = round2(receipts?.collectedCheque ?? 0);
        const collectedBank = round2(receipts?.collectedBank ?? 0);
        return {
          staff: {
            id,
            name: user.name,
            status: isUserActive(user) ? UserStatus.ACTIVE : UserStatus.INACTIVE,
            location: user.locationId
              ? { id: user.locationId.toString(), name: locationName.get(user.locationId.toString()) ?? null }
              : null,
          },
          receipts: receipts?.receipts ?? 0,
          collectedCash,
          collectedCheque,
          collectedBank,
          total: sum2([collectedCash, collectedCheque, collectedBank]),
          handedOver: round2(handovers?.handedOver ?? 0),
          pendingApproval: round2(handovers?.pendingApproval ?? 0),
          withSalesman: holding(user),
        };
      })
      .filter(
        (row) =>
          alwaysInclude.includes(row.staff.id) ||
          (Object.keys(ZERO_TOTALS) as (keyof Totals)[]).some((key) => row[key] !== 0),
      )
      .sort((a, b) => a.staff.name.localeCompare(b.staff.name));
  }

  /**
   * Users the viewer may see that match the filters, or null for "any".
   * An "own"-scoped user is limited to themselves.
   */
  private async allowedStaffIds(
    query: { staffId?: string; locationId?: string },
    viewer: ScopedUser,
  ): Promise<string[] | null> {
    let ids: string[] | null = query.staffId ? [query.staffId] : null;
    if (isOwnScope(viewer)) {
      ids = !ids || ids.includes(viewer.id) ? [viewer.id] : [];
    }
    if (query.locationId) {
      const atLocation = await this.userModel
        .find({ locationId: new Types.ObjectId(query.locationId), ...(ids ? { _id: { $in: ids } } : {}) })
        .select('_id')
        .lean()
        .exec();
      ids = atLocation.map((user) => user._id.toString());
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
      receipts: rows.reduce((count, row) => count + row.receipts, 0),
      collectedCash: total('collectedCash'),
      collectedCheque: total('collectedCheque'),
      collectedBank: total('collectedBank'),
      total: total('total'),
      handedOver: total('handedOver'),
      pendingApproval: total('pendingApproval'),
      withSalesman: total('withSalesman'),
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
