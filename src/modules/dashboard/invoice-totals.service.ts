import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model, PipelineStage } from 'mongoose';
import { SalesInvoice, SalesInvoiceDocument } from '../sales/sales-invoices/schemas/sales-invoice.schema.js';
import { salesScopeOf } from '../sales/sales-invoices/sales-invoice.service.js';
import { PurchaseInvoice, PurchaseInvoiceDocument } from '../purchase/purchase-invoices/schemas/purchase-invoice.schema.js';
import { VoucherStatus } from '../accounting/vouchers/schemas/voucher.schema.js';
import { stockLocationScope } from '../stock/stock.service.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { round2 } from '../../common/utils/money.util.js';
import type { DashboardRangeDto } from './dto/dashboard-range.dto.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily net totals of posted (not cancelled) invoices. "own"-scoped users get
 * their own: sales they created or sold, purchases at their locations.
 */
@Injectable()
export class InvoiceTotalsService {
  constructor(
    @InjectModel(SalesInvoice.name) private readonly salesModel: Model<SalesInvoiceDocument>,
    @InjectModel(PurchaseInvoice.name) private readonly purchaseModel: Model<PurchaseInvoiceDocument>,
  ) {}

  async sales(range: DashboardRangeDto, viewer: AuthenticatedUser) {
    const match = { ...this.matchOf(range), ...(salesScopeOf(viewer) ?? {}) };
    const [days, bySalesman] = await Promise.all([
      this.daily(this.salesModel as unknown as Model<unknown>, match),
      this.salesModel
        .aggregate<{ _id: Types.ObjectId; name: string; count: number; netTotal: number }>([
          { $match: match },
          { $group: { _id: '$soldById', name: { $last: '$soldByName' }, count: { $sum: 1 }, netTotal: { $sum: '$netTotal' } } },
          { $sort: { netTotal: -1 } },
        ])
        .exec(),
    ]);
    return {
      ...this.totalsOf(days),
      bySalesman: bySalesman.map((row) => ({ id: row._id.toString(), name: row.name, count: row.count, netTotal: round2(row.netTotal) })),
    };
  }

  async purchases(range: DashboardRangeDto, viewer: AuthenticatedUser) {
    const allowed = stockLocationScope(viewer);
    const match = {
      ...this.matchOf(range),
      ...(allowed ? { locationId: { $in: allowed.map((id) => new Types.ObjectId(id)) } } : {}),
    };
    return this.totalsOf(await this.daily(this.purchaseModel as unknown as Model<unknown>, match));
  }

  private matchOf(range: DashboardRangeDto): Record<string, unknown> {
    const to = range.dateTo ? new Date(range.dateTo) : new Date();
    if (!range.dateTo || /^\d{4}-\d{2}-\d{2}$/.test(range.dateTo)) to.setUTCHours(23, 59, 59, 999);
    const from = range.dateFrom ? new Date(range.dateFrom) : new Date(to.getTime() - 30 * DAY_MS);
    return { status: VoucherStatus.POSTED, voucherDate: { $gte: from, $lte: to } };
  }

  /** Voucher dates are calendar days stored at UTC midnight, so grouping in UTC keeps them on their day. */
  private daily(model: Model<unknown>, match: Record<string, unknown>) {
    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$voucherDate', timezone: 'UTC' } },
          count: { $sum: 1 },
          netTotal: { $sum: '$netTotal' },
        },
      },
      { $sort: { _id: 1 } },
    ];
    return model.aggregate<{ _id: string; count: number; netTotal: number }>(pipeline).exec();
  }

  private totalsOf(days: { _id: string; count: number; netTotal: number }[]) {
    return {
      days: days.map((row) => ({ date: row._id, count: row.count, netTotal: round2(row.netTotal) })),
      count: days.reduce((sum, row) => sum + row.count, 0),
      netTotal: round2(days.reduce((sum, row) => sum + row.netTotal, 0)),
    };
  }
}
