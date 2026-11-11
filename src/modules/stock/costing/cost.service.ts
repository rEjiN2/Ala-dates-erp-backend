import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Model } from 'mongoose';
import { CostLayer, CostLayerDocument } from './schemas/cost-layer.schema.js';
import { LayerConsumption, LayerConsumptionDocument } from './schemas/layer-consumption.schema.js';
import { StockBalance, StockBalanceDocument } from '../schemas/stock-balance.schema.js';
import { Product, ProductDocument } from '../../product/products/schemas/product.schema.js';
import { InTransitRegistry } from '../pending-receipt.js';
import { round2 } from '../../../common/utils/money.util.js';

/** Same rounding as StockService (not imported: stock.service imports this file). */
const roundQty = (qty: number) => Math.round(qty * 1000) / 1000;
const roundCost = (cost: number) => Math.round(cost * 10000) / 10000;
/** Below this a layer counts as empty (guards $inc float drift). */
const EPSILON = 0.0005;

/** The voucher line a consumption belongs to. */
export interface CostRef {
  voucherType: string;
  voucherId: Types.ObjectId;
  voucherNo: string;
  lineId?: Types.ObjectId | null;
}

export interface AddLayerInput {
  productId: Types.ObjectId | string;
  sourceType: string;
  sourceVoucherId: Types.ObjectId;
  sourceLineId?: Types.ObjectId | null;
  date: Date;
  qty: number;
  unitCost: number;
  expiryDate?: Date | null;
}

export interface ConsumeResult {
  totalCost: number;
  avgUnitCost: number;
  /** Part of the quantity had no layer left; it was costed at the latest layer cost. */
  uncosted: boolean;
  consumptions: { layerId: Types.ObjectId | null; qty: number; unitCost: number; uncosted: boolean; expiryDate: Date | null }[];
}

export interface ReconcileRow {
  productId: string;
  layerQty: number;
  onHand: number;
  inTransit: number;
  /** layerQty - (onHand + inTransit). */
  diff: number;
}

/**
 * FIFO costing: StockService says how many, this says at what cost. Every
 * method runs in the caller's transaction. Layers are company-wide per
 * product; stock transfers never touch them.
 */
@Injectable()
export class CostService {
  constructor(
    @InjectModel(CostLayer.name) private readonly layerModel: Model<CostLayerDocument>,
    @InjectModel(LayerConsumption.name) private readonly consumptionModel: Model<LayerConsumptionDocument>,
    @InjectModel(StockBalance.name) private readonly balanceModel: Model<StockBalanceDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @Optional() private readonly inTransit?: InTransitRegistry,
  ) {}

  async addLayer(input: AddLayerInput, session: ClientSession): Promise<void> {
    const qty = roundQty(input.qty);
    if (!(qty > 0)) return;
    await this.layerModel.create(
      [
        {
          productId: new Types.ObjectId(input.productId.toString()),
          sourceType: input.sourceType,
          sourceVoucherId: input.sourceVoucherId,
          sourceLineId: input.sourceLineId ?? null,
          date: input.date,
          qtyIn: qty,
          qtyRemaining: qty,
          unitCost: roundCost(Math.max(0, input.unitCost)),
          expiryDate: input.expiryDate ?? null,
          createdAt: new Date(),
        },
      ],
      { session },
    );
  }

  /**
   * Takes qty from the oldest layers with stock left (`preferSource`'s layers
   * first). A shortage never throws unless `strict`: the rest is costed at the
   * latest layer cost (else the product's purchase price) and flagged
   * uncosted; later purchases never backfill it.
   */
  async consume(
    productId: Types.ObjectId | string,
    qty: number,
    ref: CostRef,
    session: ClientSession,
    options: { preferSource?: { sourceType: string; sourceVoucherId: Types.ObjectId; sourceLineId?: Types.ObjectId | null }; strict?: boolean } = {},
  ): Promise<ConsumeResult> {
    const pid = new Types.ObjectId(productId.toString());
    let need = roundQty(qty);
    const consumptions: ConsumeResult['consumptions'] = [];

    const takeFrom = async (extra: Record<string, unknown>) => {
      for (let guard = 0; need > EPSILON && guard < 10_000; guard++) {
        const layer = await this.layerModel
          .findOne({ productId: pid, qtyRemaining: { $gt: EPSILON }, ...extra })
          .sort({ date: 1, createdAt: 1, _id: 1 })
          .session(session)
          .lean()
          .exec();
        if (!layer) return;
        const take = roundQty(Math.min(layer.qtyRemaining, need));
        // Guarded decrement: if another writer got there first this layer is re-read.
        const updated = await this.layerModel
          .findOneAndUpdate({ _id: layer._id, qtyRemaining: { $gte: take - EPSILON } }, { $inc: { qtyRemaining: -take } }, { session })
          .lean()
          .exec();
        if (!updated) continue;
        consumptions.push({ layerId: layer._id, qty: take, unitCost: layer.unitCost, uncosted: false, expiryDate: layer.expiryDate ?? null });
        need = roundQty(need - take);
      }
    };
    const preferred = options.preferSource;
    if (preferred) {
      await takeFrom({
        sourceType: preferred.sourceType,
        sourceVoucherId: preferred.sourceVoucherId,
        ...(preferred.sourceLineId ? { sourceLineId: preferred.sourceLineId } : {}),
      });
    }
    await takeFrom({});
    if (need > EPSILON) {
      if (options.strict) {
        throw new BadRequestException(`Not enough stock left in the cost layers: ${need} of ${roundQty(qty)} can't be costed`);
      }
      consumptions.push({ layerId: null, qty: need, unitCost: await this.latestCost(pid, session), uncosted: true, expiryDate: null });
    }

    if (consumptions.length > 0) {
      await this.consumptionModel.insertMany(
        consumptions.map(({ expiryDate: _expiryDate, ...row }) => ({
          ...row,
          productId: pid,
          voucherType: ref.voucherType,
          voucherId: ref.voucherId,
          voucherNo: ref.voucherNo,
          lineId: ref.lineId ?? null,
          createdAt: new Date(),
          reversedAt: null,
        })),
        { session },
      );
    }
    const totalCost = round2(consumptions.reduce((sum, row) => sum + row.qty * row.unitCost, 0));
    const total = roundQty(qty);
    return {
      totalCost,
      avgUnitCost: total > 0 ? roundCost(totalCost / total) : 0,
      uncosted: consumptions.some((row) => row.uncosted),
      consumptions,
    };
  }

  /**
   * Puts quantities back into the exact layers the ref consumed, in the order
   * they were consumed. No qty = everything. `by` (a sales return) is
   * remembered so unrestore can undo it. Returns what was restored.
   */
  async restore(
    ref: Pick<CostRef, 'voucherType' | 'voucherId' | 'lineId'>,
    qty: number | undefined,
    session: ClientSession,
    by?: { voucherType: string; voucherId: Types.ObjectId },
  ): Promise<{ qty: number; cost: number }> {
    const rows = await this.consumptionModel
      .find({
        voucherType: ref.voucherType,
        voucherId: ref.voucherId,
        reversedAt: null,
        ...(ref.lineId ? { lineId: ref.lineId } : {}),
      })
      .sort({ _id: 1 })
      .session(session)
      .lean()
      .exec();
    let left = qty === undefined ? Infinity : roundQty(qty);
    let restored = 0;
    let restoredCost = 0;
    const now = new Date();
    for (const row of rows) {
      if (left <= EPSILON) break;
      const back = roundQty(Math.min(row.qty, left));
      if (row.layerId) {
        await this.layerModel.updateOne({ _id: row.layerId }, { $inc: { qtyRemaining: back } }, { session }).exec();
      }
      await this.consumptionModel
        .updateOne(
          { _id: row._id },
          { $set: { qty: back, reversedAt: now, reversedByType: by?.voucherType ?? null, reversedById: by?.voucherId ?? null } },
          { session },
        )
        .exec();
      if (back < row.qty - EPSILON) {
        const { _id, ...rest } = row;
        await this.consumptionModel.create([{ ...rest, qty: roundQty(row.qty - back), reversedAt: null }], { session });
      }
      restored = roundQty(restored + back);
      restoredCost += back * row.unitCost;
      left = roundQty(left - back);
    }
    return { qty: restored, cost: round2(restoredCost) };
  }

  /** Restores everything a voucher consumed (edit or cancel). */
  async reverseAll(ref: Pick<CostRef, 'voucherType' | 'voucherId'>, session: ClientSession): Promise<number> {
    return (await this.restore({ voucherType: ref.voucherType, voucherId: ref.voucherId }, undefined, session)).cost;
  }

  /**
   * Undoes a restore made `by` a voucher: takes the quantities out of the same
   * layers again. Refused if they were used since.
   */
  async unrestore(by: { voucherType: string; voucherId: Types.ObjectId }, subject: string, action: string, session: ClientSession): Promise<void> {
    const rows = await this.consumptionModel
      .find({ reversedByType: by.voucherType, reversedById: by.voucherId })
      .sort({ _id: 1 })
      .session(session)
      .lean()
      .exec();
    for (const row of rows) {
      if (row.layerId) {
        const updated = await this.layerModel
          .findOneAndUpdate({ _id: row.layerId, qtyRemaining: { $gte: row.qty - EPSILON } }, { $inc: { qtyRemaining: -row.qty } }, { session })
          .lean()
          .exec();
        if (!updated) {
          throw new ConflictException(`${subject} can't be ${action}: the goods it put back into stock were already used`);
        }
      }
      await this.consumptionModel
        .updateOne({ _id: row._id }, { $set: { reversedAt: null, reversedByType: null, reversedById: null } }, { session })
        .exec();
    }
  }

  /**
   * Retires a source voucher's layers (edit or cancel). Refused, naming the
   * vouchers, while any of the stock has been consumed.
   */
  async removeLayers(
    sourceType: string,
    sourceVoucherId: Types.ObjectId,
    subject: string,
    action: string,
    session: ClientSession,
  ): Promise<void> {
    const layers = await this.layerModel.find({ sourceType, sourceVoucherId, voidedAt: null }).session(session).lean().exec();
    const used = layers.filter((layer) => layer.qtyRemaining < layer.qtyIn - EPSILON);
    if (used.length > 0) {
      const rows = await this.consumptionModel
        .find({ layerId: { $in: used.map((layer) => layer._id) }, reversedAt: null })
        .select('voucherNo')
        .session(session)
        .lean()
        .exec();
      const vouchers = [...new Set(rows.map((row) => row.voucherNo))].join(', ');
      throw new ConflictException(`${subject} can't be ${action}: its stock was already used on ${vouchers || 'other vouchers'}`);
    }
    if (layers.length > 0) {
      await this.layerModel
        .updateMany({ _id: { $in: layers.map((layer) => layer._id) } }, { $set: { qtyRemaining: 0, voidedAt: new Date() } }, { session })
        .exec();
    }
  }

  /** Per product: remaining quantity, value (sum of qtyRemaining x unitCost) and average remaining cost. */
  async valuation(productIds: readonly Types.ObjectId[]): Promise<Map<string, { qty: number; value: number; avgCost: number }>> {
    const rows = await this.layerModel
      .aggregate<{ _id: Types.ObjectId; qty: number; value: number }>([
        { $match: { productId: { $in: [...productIds] }, qtyRemaining: { $gt: EPSILON } } },
        { $group: { _id: '$productId', qty: { $sum: '$qtyRemaining' }, value: { $sum: { $multiply: ['$qtyRemaining', '$unitCost'] } } } },
      ])
      .exec();
    return new Map(
      rows.map((row) => [row._id.toString(), { qty: roundQty(row.qty), value: round2(row.value), avgCost: row.qty > 0 ? row.value / row.qty : 0 }]),
    );
  }

  /** The invariant per product: sum(layer qtyRemaining) = total StockBalance + in transit. Only products that differ unless `all`. */
  async reconcile(options: { productIds?: Types.ObjectId[]; all?: boolean } = {}): Promise<ReconcileRow[]> {
    const scope = options.productIds ? { productId: { $in: options.productIds } } : {};
    const [layers, balances] = await Promise.all([
      this.layerModel.aggregate<{ _id: Types.ObjectId; qty: number }>([{ $match: scope }, { $group: { _id: '$productId', qty: { $sum: '$qtyRemaining' } } }]).exec(),
      this.balanceModel.aggregate<{ _id: Types.ObjectId; qty: number }>([{ $match: scope }, { $group: { _id: '$productId', qty: { $sum: '$qty' } } }]).exec(),
    ]);
    const ids = new Map<string, Types.ObjectId>();
    for (const row of [...layers, ...balances]) ids.set(row._id.toString(), row._id);
    const transit = this.inTransit ? await this.inTransit.quantities([...ids.values()], null) : new Map<string, number>();
    const rows: ReconcileRow[] = [...ids.keys()].map((productId) => {
      const layerQty = roundQty(layers.find((row) => row._id.toString() === productId)?.qty ?? 0);
      const onHand = roundQty(balances.find((row) => row._id.toString() === productId)?.qty ?? 0);
      const inTransit = transit.get(productId) ?? 0;
      return { productId, layerQty, onHand, inTransit, diff: roundQty(layerQty - (onHand + inTransit)) };
    });
    return rows.filter((row) => options.all || row.diff !== 0);
  }

  /** The latest layer's unit cost, else the product's purchase price: what a shortage or an unexplained excess is costed at. */
  async latestCost(productId: Types.ObjectId, session: ClientSession): Promise<number> {
    const latest = await this.layerModel
      .findOne({ productId, voidedAt: null })
      .sort({ date: -1, createdAt: -1, _id: -1 })
      .session(session)
      .lean()
      .exec();
    if (latest) return latest.unitCost;
    const product = await this.productModel.findById(productId).select('purchasePrice').session(session).lean().exec();
    return product?.purchasePrice ?? 0;
  }
}
