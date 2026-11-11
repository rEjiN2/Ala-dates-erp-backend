import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { BatchExpiryQueryDto } from './dto/batch-expiry.dto.js';
import { CostLayer, CostLayerDocument } from '../stock/costing/schemas/cost-layer.schema.js';
import { Product, ProductDocument } from '../product/products/schemas/product.schema.js';
import { Permission, hasPermission } from '../roles/permissions.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Cost layers with stock left and an expiry date, soonest first. */
@Injectable()
export class BatchExpiryService {
  constructor(
    @InjectModel(CostLayer.name) private readonly layerModel: Model<CostLayerDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
  ) {}

  async report(query: BatchExpiryQueryDto, viewer: AuthenticatedUser) {
    const asOf = startOfDay(query.asOf ? new Date(query.asOf) : new Date());
    const filter: Record<string, unknown> = { qtyRemaining: { $gt: 0.0005 }, voidedAt: null };
    filter.expiryDate =
      query.daysAhead !== undefined ? { $ne: null, $lt: new Date(asOf.getTime() + (query.daysAhead + 1) * DAY_MS) } : { $ne: null };
    if (query.productId) filter.productId = new Types.ObjectId(query.productId);

    const layers = await this.layerModel.find(filter).sort({ expiryDate: 1, date: 1, _id: 1 }).lean().exec();
    const products = new Map(
      (
        await this.productModel
          .find({ _id: { $in: layers.map((layer) => layer.productId) } })
          .select('code name')
          .lean()
          .exec()
      ).map((product) => [product._id.toString(), product]),
    );
    const canViewCost = hasPermission(viewer, Permission.PRODUCTS_VIEW_COST);
    return {
      asOf,
      items: layers.map((layer) => {
        const product = products.get(layer.productId.toString());
        return {
          product: { id: layer.productId.toString(), code: product?.code ?? null, name: product?.name ?? null },
          remaining: Math.round(layer.qtyRemaining * 1000) / 1000,
          expiryDate: layer.expiryDate,
          daysLeft: Math.round((startOfDay(layer.expiryDate!).getTime() - asOf.getTime()) / DAY_MS),
          ...(canViewCost ? { unitCost: layer.unitCost } : {}),
        };
      }),
    };
  }
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
