import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Model } from 'mongoose';
import { StockEntry, StockEntryDocument } from './schemas/stock-entry.schema.js';
import { StockBalance, StockBalanceDocument } from './schemas/stock-balance.schema.js';
import { StockHistoryQueryDto, StockSummaryQueryDto } from './dto/stock.dto.js';
import { Product, ProductDocument, ProductType } from '../product/products/schemas/product.schema.js';
import { ProductService } from '../product/products/product.service.js';
import { ProductUsageRegistry } from '../product/products/product-usage.registry.js';
import { Unit, UnitDocument } from '../product/units/schemas/unit.schema.js';
import { ProductGroup, ProductGroupDocument } from '../product/product-groups/schemas/product-group.schema.js';
import { Location, LocationDocument, LocationStatus, LocationType } from '../location/schemas/location.schema.js';
import { CompanyService } from '../company/company.service.js';
import { DataScope, Permission, hasPermission } from '../roles/permissions.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { escapeRegExp } from '../sequence/code-sequence.js';
import { type Actor, toUserSnapshot, userRefOf } from '../../common/schemas/user-snapshot.schema.js';
import { round2 } from '../../common/utils/money.util.js';

/** Branches are organisational; only these hold stock. */
export const STOCK_LOCATION_TYPES: readonly LocationType[] = [LocationType.WAREHOUSE, LocationType.STORE, LocationType.VAN];
export const STOCK_PRODUCT_TYPES: readonly ProductType[] = [ProductType.STOCK, ProductType.BUNDLE];

export interface StockEntryInput {
  productId: Types.ObjectId | string;
  locationId: Types.ObjectId | string;
  /** Signed: in > 0, out < 0. */
  qty: number;
  date: Date;
  voucherType: string;
  voucherId: Types.ObjectId;
  voucherNo: string;
  unitCost?: number | null;
  reversalOf?: Types.ObjectId | null;
}

export type StockStatus = 'ok' | 'reorder' | 'below_min';

export interface StockSummaryRow {
  productId: string;
  code: string;
  name: string;
  group: { id: string; name: string } | null;
  unit: { id: string; name: string; symbol: string } | null;
  total: number;
  byLocation: { locationId: string; name: string | null; qty: number }[];
  status: StockStatus;
  /** total x purchasePrice; only with products:view-cost. */
  value?: number;
}

/** Quantities may be fractional (kg); 3 decimals keeps $inc drift out of comparisons. */
export const roundQty = (qty: number) => Math.round(qty * 1000) / 1000;

type StockViewer = Pick<AuthenticatedUser, 'dataScope' | 'allowedLocationIds'>;

/** The locations an "own"-scoped user sees stock for; null when they see all. */
export function stockLocationScope(user: StockViewer | undefined): string[] | null {
  return user?.dataScope === DataScope.OWN ? (user.allowedLocationIds ?? []) : null;
}

/**
 * The stock engine: StockService.post writes insert-only StockEntry rows and
 * moves StockBalance in the caller's transaction. A result below zero is
 * rejected unless Company.allowNegativeStock (never for a strict post, e.g.
 * a cancel).
 */
@Injectable()
export class StockService {
  constructor(
    @InjectModel(StockEntry.name) private readonly entryModel: Model<StockEntryDocument>,
    @InjectModel(StockBalance.name) private readonly balanceModel: Model<StockBalanceDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Unit.name) private readonly unitModel: Model<UnitDocument>,
    @InjectModel(ProductGroup.name) private readonly groupModel: Model<ProductGroupDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    private readonly companyService: CompanyService,
    private readonly productService: ProductService,
    productUsage: ProductUsageRegistry,
  ) {
    productUsage.register('stock entries', async (productId, session) =>
      Boolean(
        await this.entryModel
          .exists({ productId })
          .session(session ?? null)
          .exec(),
      ),
    );
  }

  /** Writes the entries and moves each product+location balance by its net quantity. */
  async post(
    entries: readonly StockEntryInput[],
    actor: Actor,
    session: ClientSession,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    const postedAt = new Date();
    const by = toUserSnapshot(actor);
    const rows = entries
      .filter((entry) => roundQty(entry.qty) !== 0)
      .map((entry) => ({
        productId: new Types.ObjectId(entry.productId.toString()),
        locationId: new Types.ObjectId(entry.locationId.toString()),
        qty: roundQty(entry.qty),
        date: entry.date,
        voucherType: entry.voucherType,
        voucherId: entry.voucherId,
        voucherNo: entry.voucherNo,
        unitCost: entry.unitCost ?? null,
        reversalOf: entry.reversalOf ?? null,
        by,
        postedAt,
      }));
    if (rows.length === 0) return;
    // Reversals undo what was already allowed; only new movements must be stock-holding.
    const fresh = rows.filter((row) => !row.reversalOf);
    if (fresh.length > 0) {
      await this.assertHoldsStock(
        fresh.map((row) => row.productId.toString()),
        fresh.map((row) => row.locationId.toString()),
        session,
      );
    }
    await this.entryModel.insertMany(rows, { session });

    const deltas = new Map<string, { productId: Types.ObjectId; locationId: Types.ObjectId; qty: number }>();
    for (const row of rows) {
      const key = `${row.productId.toString()}:${row.locationId.toString()}`;
      const current = deltas.get(key) ?? { productId: row.productId, locationId: row.locationId, qty: 0 };
      deltas.set(key, { ...current, qty: roundQty(current.qty + row.qty) });
    }
    const allowNegative = !options.strict && Boolean((await this.companyService.ensure()).allowNegativeStock);
    const negative: { productId: Types.ObjectId; locationId: Types.ObjectId; qty: number }[] = [];
    for (const delta of deltas.values()) {
      if (delta.qty === 0) continue;
      const balance = await this.balanceModel
        .findOneAndUpdate(
          { productId: delta.productId, locationId: delta.locationId },
          { $inc: { qty: delta.qty } },
          { upsert: true, returnDocument: 'after', session },
        )
        .lean()
        .exec();
      const after = roundQty(balance!.qty);
      // Only a decrease is refused: a receipt into an already-negative balance must still go through.
      if (after < 0 && delta.qty < 0 && !allowNegative) {
        negative.push({ ...delta, qty: after });
      }
    }
    if (negative.length > 0) {
      const products = await this.labels(this.productModel, negative.map((row) => row.productId), session);
      const locations = await this.labels(this.locationModel, negative.map((row) => row.locationId), session);
      throw new BadRequestException(
        `Not enough stock: ${negative
          .map(
            (row) =>
              `${products.get(row.productId.toString())} at ${locations.get(row.locationId.toString())} would be ${row.qty}`,
          )
          .join('; ')}`,
      );
    }
  }

  /** Entries that undo every not-yet-reversed entry of the voucher, dated as the originals. */
  async reversalsOf(voucherType: string, voucherId: Types.ObjectId, session: ClientSession): Promise<StockEntryInput[]> {
    const entries = await this.entryModel.find({ voucherType, voucherId }).session(session).lean().exec();
    const reversed = new Set(entries.flatMap((entry) => (entry.reversalOf ? [entry.reversalOf.toString()] : [])));
    return entries
      .filter((entry) => !entry.reversalOf && !reversed.has(entry._id.toString()))
      .map((entry) => ({
        productId: entry.productId,
        locationId: entry.locationId,
        qty: -entry.qty,
        date: entry.date,
        voucherType,
        voucherId,
        voucherNo: entry.voucherNo,
        unitCost: entry.unitCost,
        reversalOf: entry._id,
      }));
  }

  /** Every location must be an active warehouse, store or van; every product of type stock or bundle. */
  async assertHoldsStock(productIds: readonly string[], locationIds: readonly string[], session?: ClientSession) {
    const unique = (ids: readonly string[]) => [...new Set(ids)].map((id) => new Types.ObjectId(id));
    // Sequential: parallel reads can't open the same transaction.
    const locations = await this.locationModel
      .find({ _id: { $in: unique(locationIds) } })
      .select('code name type status')
      .session(session ?? null)
      .lean()
      .exec();
    const products = await this.productModel
      .find({ _id: { $in: unique(productIds) } })
      .select('code name type')
      .session(session ?? null)
      .lean()
      .exec();
    for (const id of new Set(locationIds)) {
      const location = locations.find((candidate) => candidate._id.toString() === id);
      if (!location) throw new NotFoundException(`Location ${id} not found`);
      if (!STOCK_LOCATION_TYPES.includes(location.type)) {
        throw new BadRequestException(
          `${location.code} (${location.name}) is a ${location.type}: only warehouses, stores and vans hold stock`,
        );
      }
      if (location.status !== LocationStatus.ACTIVE) {
        throw new BadRequestException(`Location ${location.code} (${location.name}) is inactive`);
      }
    }
    for (const id of new Set(productIds)) {
      const product = products.find((candidate) => candidate._id.toString() === id);
      if (!product) throw new NotFoundException(`Product ${id} not found`);
      if (!STOCK_PRODUCT_TYPES.includes(product.type)) {
        throw new BadRequestException(`${product.code} (${product.name}) is a ${product.type} product and holds no stock`);
      }
    }
  }

  /** One row per stock/bundle product: total and per-location quantities, level status, value with products:view-cost. */
  async summary(query: StockSummaryQueryDto, viewer: AuthenticatedUser) {
    const locationIds = this.visibleLocations(viewer, query.locationId);
    const filter: Record<string, unknown> = { type: { $in: STOCK_PRODUCT_TYPES } };
    const term = query.q?.trim();
    if (term) {
      const pattern = new RegExp(escapeRegExp(term), 'i');
      filter.$or = [{ name: pattern }, { code: pattern }, { barcode: pattern }];
    }
    if (query.groupId) filter.productGroupId = { $in: await this.productService.groupWithDescendants(query.groupId) };

    const products = await this.productModel
      .find(filter)
      .select('code name productGroupId unitId purchasePrice minStock reorderLevel')
      .sort({ code: 1 })
      .lean()
      .exec();
    const [balances, units, groups] = await Promise.all([
      this.balanceModel
        .find({
          productId: { $in: products.map((product) => product._id) },
          ...(locationIds ? { locationId: { $in: locationIds.map((id) => new Types.ObjectId(id)) } } : {}),
        })
        .lean()
        .exec(),
      this.unitModel
        .find({ _id: { $in: products.map((product) => product.unitId) } })
        .select('name symbol')
        .lean()
        .exec(),
      this.groupModel
        .find({ _id: { $in: products.map((product) => product.productGroupId) } })
        .select('name')
        .lean()
        .exec(),
    ]);
    const groupName = new Map(groups.map((group) => [group._id.toString(), group.name]));
    const held = balances.filter((balance) => roundQty(balance.qty) !== 0);
    const locationNames = new Map(
      (
        await this.locationModel
          .find({ _id: { $in: held.map((balance) => balance.locationId) } })
          .select('name')
          .lean()
          .exec()
      ).map((location) => [location._id.toString(), location.name]),
    );
    const unitById = new Map(
      units.map((unit) => [unit._id.toString(), { id: unit._id.toString(), name: unit.name, symbol: unit.symbol }]),
    );
    const canViewCost = hasPermission(viewer, Permission.PRODUCTS_VIEW_COST);

    let rows: StockSummaryRow[] = products.map((product) => {
      const byLocation = held
        .filter((balance) => balance.productId.equals(product._id))
        .map((balance) => ({
          locationId: balance.locationId.toString(),
          name: locationNames.get(balance.locationId.toString()) ?? null,
          qty: roundQty(balance.qty),
        }));
      const total = roundQty(byLocation.reduce((sum, row) => sum + row.qty, 0));
      return {
        productId: product._id.toString(),
        code: product.code,
        name: product.name,
        group: groupName.has(product.productGroupId.toString())
          ? { id: product.productGroupId.toString(), name: groupName.get(product.productGroupId.toString())! }
          : null,
        unit: unitById.get(product.unitId.toString()) ?? null,
        total,
        byLocation,
        status: levelStatus(total, product),
        ...(canViewCost ? { value: round2(total * (product.purchasePrice ?? 0)) } : {}),
      };
    });
    if (query.lowStock) rows = rows.filter((row) => row.status !== 'ok');

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  }

  /** A product's entries in date order with in, out and the running balance (over the visible locations). */
  async history(query: StockHistoryQueryDto, viewer: AuthenticatedUser) {
    const locationIds = this.visibleLocations(viewer, query.locationId);
    const base: Record<string, unknown> = {
      productId: new Types.ObjectId(query.productId),
      ...(locationIds ? { locationId: { $in: locationIds.map((id) => new Types.ObjectId(id)) } } : {}),
    };
    const range: { $gte?: Date; $lte?: Date } = {};
    if (query.dateFrom) range.$gte = new Date(query.dateFrom);
    if (query.dateTo) range.$lte = endOfDayIfDateOnly(query.dateTo);

    const [before, entries] = await Promise.all([
      range.$gte
        ? this.entryModel
            .aggregate<{ qty: number }>([
              { $match: { ...base, date: { $lt: range.$gte } } },
              { $group: { _id: null, qty: { $sum: '$qty' } } },
            ])
            .exec()
        : [],
      this.entryModel
        .find({ ...base, ...(range.$gte || range.$lte ? { date: range } : {}) })
        .sort({ date: 1, _id: 1 })
        .lean()
        .exec(),
    ]);
    const locations = new Map(
      (
        await this.locationModel
          .find({ _id: { $in: entries.map((entry) => entry.locationId) } })
          .select('name')
          .lean()
          .exec()
      ).map((location) => [location._id.toString(), location.name]),
    );
    const opening = roundQty(before[0]?.qty ?? 0);
    let balance = opening;
    const items = entries.map((entry) => {
      balance = roundQty(balance + entry.qty);
      return {
        id: entry._id.toString(),
        date: entry.date,
        voucherType: entry.voucherType,
        voucherId: entry.voucherId.toString(),
        voucherNo: entry.voucherNo,
        location: { id: entry.locationId.toString(), name: locations.get(entry.locationId.toString()) ?? null },
        in: entry.qty > 0 ? entry.qty : 0,
        out: entry.qty < 0 ? -entry.qty : 0,
        balance,
        isReversal: Boolean(entry.reversalOf),
        by: userRefOf(entry.by),
      };
    });
    return { productId: query.productId, opening, closing: balance, items };
  }

  /** The requested location (403 outside the viewer's scope), else the viewer's scope (null = all). */
  private visibleLocations(viewer: StockViewer, locationId?: string): string[] | null {
    const allowed = stockLocationScope(viewer);
    if (locationId && allowed && !allowed.includes(locationId)) {
      throw new ForbiddenException('You may not see stock at this location');
    }
    return locationId ? [locationId] : allowed;
  }

  private async labels(
    model: Model<ProductDocument> | Model<LocationDocument>,
    ids: Types.ObjectId[],
    session: ClientSession,
  ): Promise<Map<string, string>> {
    const docs = await (model as unknown as Model<{ code: string; name: string }>)
      .find({ _id: { $in: ids } })
      .select('code name')
      .session(session)
      .lean()
      .exec();
    return new Map(docs.map((doc) => [doc._id.toString(), `${doc.code} (${doc.name})`]));
  }
}

/** Below the minimum, or at/below the reorder level; levels never block anything. */
function levelStatus(total: number, product: { minStock?: number | null; reorderLevel?: number | null }): StockStatus {
  if (product.minStock != null && total < product.minStock) return 'below_min';
  if (product.reorderLevel != null && total <= product.reorderLevel) return 'reorder';
  return 'ok';
}

/** A date-only filter bound covers the whole day. */
function endOfDayIfDateOnly(value: string): Date {
  const date = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}
