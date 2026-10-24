import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import {
  OPENING_STOCK_ENTITY_TYPE,
  OpeningStock,
  OpeningStockDocument,
  type OpeningStockLine,
} from './schemas/opening-stock.schema.js';
import {
  CancelOpeningStockDto,
  CreateOpeningStockDto,
  OpeningStockQueryDto,
  UpdateOpeningStockDto,
  ValidateOpeningStockDto,
} from './dto/opening-stock.dto.js';
import { STOCK_PRODUCT_TYPES, StockService, roundQty, stockLocationScope, type StockEntryInput } from '../stock.service.js';
import { Product, ProductDocument, ProductType } from '../../product/products/schemas/product.schema.js';
import { Location, LocationDocument } from '../../location/schemas/location.schema.js';
import { VoucherStatus } from '../../accounting/vouchers/schemas/voucher.schema.js';
import { withScope } from '../../accounting/vouchers/data-scope.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { escapeRegExp } from '../../sequence/code-sequence.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction, type AuditChange } from '../../audit/schemas/audit-log.schema.js';
import { CommentsService } from '../../comments/comments.service.js';
import { EntityAccessRegistry } from '../../comments/entity-access.registry.js';
import { Permission, hasPermission } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { type UserSnapshot, toUserSnapshot, userRefOf } from '../../../common/schemas/user-snapshot.schema.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

type Viewer = AuthenticatedUser;

const SEQUENCE = { key: 'opening-stock', prefix: 'OS-', width: 4 };
const LABEL = 'Opening stock';

interface LineInput {
  productId?: string;
  productCode?: string;
  qty?: number;
  unitCost?: number | null;
}

export interface CheckedStockLine {
  row: number;
  productCode: string | null;
  productId: string | null;
  productName: string | null;
  productType: ProductType | null;
  qty: number;
  unitCost: number | null;
}

export interface StockRowError {
  row: number;
  productCode: string | null;
  message: string;
}

/**
 * Opening stock vouchers. Each posts one stock entry per line through
 * StockService, in one transaction with its number and audit entry. Edit =
 * reverse + repost (checked on the net result); cancel reverses strictly.
 * "own"-scoped users see and enter only their allowedLocationIds.
 */
@Injectable()
export class OpeningStockService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(OpeningStock.name) private readonly model: Model<OpeningStockDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    private readonly stockService: StockService,
    private readonly sequenceService: SequenceService,
    private readonly auditService: AuditService,
    private readonly commentsService: CommentsService,
    entityAccess: EntityAccessRegistry,
  ) {
    entityAccess.register(OPENING_STOCK_ENTITY_TYPE, {
      exists: async (id, user) => Boolean(await this.model.exists(withScope({ _id: id }, scopeOf(user))).exec()),
      canRead: (user) => hasPermission(user, Permission.OPENING_STOCK_READ),
    });
  }

  async findAll(query: OpeningStockQueryDto = {}, viewer?: Viewer) {
    const filter: Record<string, unknown> = {};
    if (query.dateFrom || query.dateTo) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) range.$gte = new Date(query.dateFrom);
      if (query.dateTo) range.$lte = endOfDayIfDateOnly(query.dateTo);
      filter.asOfDate = range;
    }
    if (query.status === 'posted') filter.status = VoucherStatus.POSTED;
    else if (query.status === 'cancelled') filter.status = VoucherStatus.CANCELLED;
    if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
    if (query.productId) filter['lines.productId'] = new Types.ObjectId(query.productId);
    const term = query.q?.trim();
    if (term) {
      const pattern = new RegExp(escapeRegExp(term), 'i');
      filter.$or = [{ voucherNo: pattern }, { comments: pattern }];
    }
    const scoped = withScope(filter, scopeOf(viewer));
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [docs, count] = await Promise.all([
      this.model
        .find(scoped)
        .sort({ asOfDate: -1, voucherNo: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
      this.model.countDocuments(scoped).exec(),
    ]);
    const [comments, locations] = await Promise.all([
      this.commentsService.countByEntityIds(
        OPENING_STOCK_ENTITY_TYPE,
        docs.map((doc) => doc._id),
      ),
      this.locationNames(docs.map((doc) => doc.locationId)),
    ]);
    return {
      items: docs.map((doc) => ({
        id: doc._id.toString(),
        voucherNo: doc.voucherNo,
        asOfDate: doc.asOfDate,
        location: { id: doc.locationId.toString(), name: locations.get(doc.locationId.toString()) ?? null },
        lineCount: doc.lines.length,
        totalQty: doc.totalQty,
        status: doc.status,
        createdBy: userRefOf(doc.createdBy as UserSnapshot | null),
        createdAt: doc.createdAt ?? null,
        updatedBy: userRefOf(doc.updatedBy as UserSnapshot | null),
        updatedAt: doc.updatedAt ?? null,
        commentCount: comments.get(doc._id.toString()) ?? 0,
      })),
      page,
      pageSize,
      summary: { count },
    };
  }

  async findById(id: string, viewer?: Viewer): Promise<OpeningStockDocument> {
    assertValidId(id);
    const doc = await this.model.findOne(withScope({ _id: new Types.ObjectId(id) }, scopeOf(viewer))).exec();
    if (!doc) {
      throw new NotFoundException(`${LABEL} ${id} not found`);
    }
    return doc;
  }

  /** Lines by product code, resolved and checked like a save would; nothing is posted. */
  async validate(dto: ValidateOpeningStockDto, viewer: Viewer) {
    if (dto.locationId) {
      assertLocationAllowed(viewer, dto.locationId);
      await this.stockService.assertHoldsStock([], [dto.locationId]);
    }
    const { lines, errors } = await this.check(
      dto.lines,
      dto.locationId ?? null,
      dto.voucherId ? new Types.ObjectId(dto.voucherId) : null,
    );
    return { valid: errors.length === 0, lines, errors, totalQty: roundQty(lines.reduce((sum, line) => sum + line.qty, 0)) };
  }

  async create(dto: CreateOpeningStockDto, actor: Viewer): Promise<OpeningStockDocument> {
    assertNotFuture(dto.asOfDate);
    assertLocationAllowed(actor, dto.locationId);

    return runInTransaction(this.connection, async (session) => {
      const lines = await this.checkedLines(dto.lines, dto.locationId, null, session);
      const voucherNo = await this.sequenceService.nextCode(SEQUENCE, session);
      const now = new Date();
      const [created] = await this.model.create(
        [
          {
            voucherNo,
            asOfDate: new Date(dto.asOfDate),
            locationId: new Types.ObjectId(dto.locationId),
            comments: dto.comments,
            lines,
            totalQty: totalQtyOf(lines),
            status: VoucherStatus.POSTED,
            createdBy: toUserSnapshot(actor),
            createdAt: now,
          },
        ],
        { session },
      );
      await this.stockService.post(this.entriesOf(created), actor, session);
      await this.record(created, AuditAction.CREATED, actor, now, session);
      return created;
    });
  }

  /** Reverses the old entries and posts the new ones in one post, so only the net result is checked. */
  async update(id: string, dto: UpdateOpeningStockDto, actor: Viewer): Promise<OpeningStockDocument> {
    if (dto.asOfDate !== undefined) assertNotFuture(dto.asOfDate);
    if (dto.locationId !== undefined) assertLocationAllowed(actor, dto.locationId);

    return runInTransaction(this.connection, async (session) => {
      const existing = await this.load(id, scopeOf(actor), session);
      assertNotCancelled(existing, 'edited');
      const nextLocationId = dto.locationId ?? existing.locationId.toString();
      const locationChanged = nextLocationId !== existing.locationId.toString();
      const nextLines =
        dto.lines || locationChanged
          ? await this.checkedLines(dto.lines ?? existing.lines.map(toInput), nextLocationId, existing._id, session)
          : existing.lines;
      const next = {
        asOfDate: dto.asOfDate !== undefined ? new Date(dto.asOfDate) : existing.asOfDate,
        locationId: nextLocationId,
        comments: dto.comments !== undefined ? dto.comments : existing.comments,
        lines: nextLines,
      };

      const changes = await this.diff(existing, next, session);
      if (changes.length === 0) {
        throw new BadRequestException('No changes to save');
      }

      const reversals = await this.stockService.reversalsOf(OPENING_STOCK_ENTITY_TYPE, existing._id, session);
      const now = new Date();
      existing.asOfDate = next.asOfDate;
      existing.locationId = new Types.ObjectId(next.locationId);
      existing.comments = next.comments;
      existing.lines = next.lines;
      existing.totalQty = totalQtyOf(next.lines);
      existing.updatedBy = toUserSnapshot(actor);
      existing.updatedAt = now;
      await existing.save({ session });
      await this.stockService.post([...reversals, ...this.entriesOf(existing)], actor, session);
      await this.record(existing, AuditAction.UPDATED, actor, now, session, { changes, reason: dto.changeNote });
      return existing;
    });
  }

  /** Reverses the entries; refused if any balance would go below zero (stock already used). */
  async cancel(id: string, dto: CancelOpeningStockDto, actor: Viewer): Promise<OpeningStockDocument> {
    const reason = dto.reason.trim();

    return runInTransaction(this.connection, async (session) => {
      const existing = await this.load(id, scopeOf(actor), session);
      assertNotCancelled(existing, 'cancelled again');
      await this.stockService.post(
        await this.stockService.reversalsOf(OPENING_STOCK_ENTITY_TYPE, existing._id, session),
        actor,
        session,
        { strict: true },
      );
      const now = new Date();
      existing.status = VoucherStatus.CANCELLED;
      existing.cancelledBy = toUserSnapshot(actor);
      existing.cancelledAt = now;
      existing.cancelReason = reason;
      await existing.save({ session });
      await this.record(existing, AuditAction.CANCELLED, actor, now, session, {
        changes: [{ field: 'status', label: 'Status', from: VoucherStatus.POSTED, to: VoucherStatus.CANCELLED }],
        reason,
      });
      return existing;
    });
  }

  private entriesOf(doc: OpeningStockDocument): StockEntryInput[] {
    return doc.lines.map((line) => ({
      productId: line.productId,
      locationId: doc.locationId,
      qty: line.qty,
      date: doc.asOfDate,
      voucherType: OPENING_STOCK_ENTITY_TYPE,
      voucherId: doc._id,
      voucherNo: doc.voucherNo,
      unitCost: line.unitCost,
    }));
  }

  /** Checked lines as stored; any row error rejects the save with every row's message. */
  private async checkedLines(
    inputs: readonly LineInput[],
    locationId: string,
    exceptId: Types.ObjectId | null,
    session: ClientSession,
  ): Promise<OpeningStockLine[]> {
    await this.stockService.assertHoldsStock([], [locationId], session);
    const { lines, errors } = await this.check(inputs, locationId, exceptId, session);
    if (errors.length > 0) {
      throw new BadRequestException(errors.map((error) => `Line ${error.row}: ${error.message}`).join('; '));
    }
    return lines.map((line) => ({
      productId: new Types.ObjectId(line.productId!),
      qty: line.qty,
      unitCost: line.unitCost,
    }));
  }

  /**
   * Resolves each row's product (by id or code) and reports per row: unknown
   * product, one that holds no stock, quantity not above 0, negative cost, a
   * product twice here or already on another non-cancelled opening at the location.
   */
  private async check(
    inputs: readonly LineInput[],
    locationId: string | null,
    exceptId: Types.ObjectId | null,
    session?: ClientSession,
  ): Promise<{ lines: CheckedStockLine[]; errors: StockRowError[] }> {
    const ids = inputs.flatMap((input) => (input.productId && Types.ObjectId.isValid(input.productId) ? [input.productId] : []));
    const codes = inputs.flatMap((input) => (input.productCode ? [input.productCode.trim().toUpperCase()] : []));
    const products = await this.productModel
      .find({ $or: [{ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }, { code: { $in: codes } }] })
      .select('code name type')
      .session(session ?? null)
      .lean()
      .exec();
    const resolve = (input: LineInput) =>
      products.find((product) =>
        input.productCode
          ? product.code === input.productCode.trim().toUpperCase()
          : product._id.toString() === input.productId,
      ) ?? null;

    const errors: StockRowError[] = [];
    const seen = new Set<string>();
    const lines = inputs.map((input, index): CheckedStockLine => {
      const row = index + 1;
      const product = resolve(input);
      const fail = (message: string) =>
        errors.push({ row, productCode: product?.code ?? input.productCode ?? null, message });
      const qty = roundQty(input.qty ?? 0);
      const unitCost = input.unitCost ?? null;

      if (!product) {
        fail(input.productCode ? `Unknown product code "${input.productCode}"` : `Product ${input.productId} not found`);
      } else {
        const name = `${product.code} (${product.name})`;
        if (!STOCK_PRODUCT_TYPES.includes(product.type)) fail(`${name} is a ${product.type} product and holds no stock`);
        const id = product._id.toString();
        if (seen.has(id)) fail(`${name} is on more than one line`);
        seen.add(id);
      }
      if (!(qty > 0)) fail('Quantity must be greater than 0');
      if (unitCost !== null && unitCost < 0) fail('Unit cost cannot be negative');

      return {
        row,
        productCode: product?.code ?? input.productCode ?? null,
        productId: product?._id.toString() ?? null,
        productName: product?.name ?? null,
        productType: product?.type ?? null,
        qty,
        unitCost,
      };
    });

    // One opening line per product+location: any other non-cancelled opening at this location holding it.
    if (locationId && seen.size > 0) {
      const clashes = await this.model
        .find({
          status: { $ne: VoucherStatus.CANCELLED },
          locationId: new Types.ObjectId(locationId),
          'lines.productId': { $in: [...seen].map((id) => new Types.ObjectId(id)) },
          ...(exceptId ? { _id: { $ne: exceptId } } : {}),
        })
        .select('voucherNo lines.productId')
        .session(session ?? null)
        .lean()
        .exec();
      const usedOn = new Map<string, string>();
      for (const clash of clashes) {
        for (const line of clash.lines) usedOn.set(line.productId.toString(), clash.voucherNo);
      }
      for (const line of lines) {
        const voucherNo = line.productId ? usedOn.get(line.productId) : undefined;
        if (voucherNo) {
          errors.push({
            row: line.row,
            productCode: line.productCode,
            message: `${line.productCode} (${line.productName}) already has opening stock at this location on ${voucherNo}`,
          });
        }
      }
      errors.sort((a, b) => a.row - b.row);
    }
    return { lines, errors };
  }

  /** Field diff for the audit: date, location, comments, and each product's quantity @ cost. */
  private async diff(
    before: OpeningStockDocument,
    after: { asOfDate: Date; locationId: string; comments?: string; lines: readonly OpeningStockLine[] },
    session: ClientSession,
  ): Promise<AuditChange[]> {
    const changes: AuditChange[] = [];
    const day = (date: Date) => date.toISOString().slice(0, 10);
    if (day(before.asOfDate) !== day(after.asOfDate)) {
      changes.push({ field: 'asOfDate', label: 'As of', from: day(before.asOfDate), to: day(after.asOfDate) });
    }
    if (before.locationId.toString() !== after.locationId) {
      const names = await this.locationNames([before.locationId, new Types.ObjectId(after.locationId)], session);
      changes.push({
        field: 'locationId',
        label: 'Location',
        from: names.get(before.locationId.toString()) ?? before.locationId.toString(),
        to: names.get(after.locationId) ?? after.locationId,
      });
    }
    if ((before.comments ?? '') !== (after.comments ?? '')) {
      changes.push({ field: 'comments', label: 'Comments', from: before.comments ?? null, to: after.comments ?? null });
    }
    const describe = (lines: readonly OpeningStockLine[]) =>
      new Map(
        lines.map((line) => [
          line.productId.toString(),
          line.unitCost != null ? `${line.qty} @ ${line.unitCost.toFixed(2)}` : `${line.qty}`,
        ]),
      );
    const from = describe(before.lines);
    const to = describe(after.lines);
    const productIds = [...new Set([...from.keys(), ...to.keys()])].filter((id) => from.get(id) !== to.get(id));
    const products = await this.productModel
      .find({ _id: { $in: productIds.map((id) => new Types.ObjectId(id)) } })
      .select('name')
      .session(session)
      .lean()
      .exec();
    const names = new Map(products.map((product) => [product._id.toString(), product.name]));
    for (const productId of productIds) {
      changes.push({
        field: 'lines',
        label: names.get(productId) ?? productId,
        from: from.get(productId) ?? null,
        to: to.get(productId) ?? null,
      });
    }
    return changes;
  }

  private async locationNames(ids: Types.ObjectId[], session?: ClientSession): Promise<Map<string, string>> {
    const locations = await this.locationModel
      .find({ _id: { $in: ids } })
      .select('name')
      .session(session ?? null)
      .lean()
      .exec();
    return new Map(locations.map((location) => [location._id.toString(), location.name]));
  }

  private async load(id: string, scope: Record<string, unknown> | null, session: ClientSession) {
    assertValidId(id);
    const doc = await this.model
      .findOne(withScope({ _id: new Types.ObjectId(id) }, scope))
      .session(session)
      .exec();
    if (!doc) {
      throw new NotFoundException(`${LABEL} ${id} not found`);
    }
    return doc;
  }

  private record(
    doc: OpeningStockDocument,
    action: AuditAction,
    actor: Viewer,
    at: Date,
    session: ClientSession,
    extra: { changes?: AuditChange[]; reason?: string } = {},
  ) {
    return this.auditService.record(
      { entityType: OPENING_STOCK_ENTITY_TYPE, entityId: doc._id, entityRef: doc.voucherNo, action, actor, at, ...extra },
      session,
    );
  }
}

/** "own"-scoped users: only vouchers at their allowed locations. */
function scopeOf(user: Viewer | undefined): Record<string, unknown> | null {
  const allowed = stockLocationScope(user);
  return allowed ? { locationId: { $in: allowed.map((id) => new Types.ObjectId(id)) } } : null;
}

function assertLocationAllowed(user: Viewer, locationId: string): void {
  const allowed = stockLocationScope(user);
  if (allowed && !allowed.includes(locationId)) {
    throw new ForbiddenException('You may not enter stock at this location');
  }
}

function toInput(line: OpeningStockLine): LineInput {
  return { productId: line.productId.toString(), qty: line.qty, unitCost: line.unitCost };
}

function totalQtyOf(lines: readonly { qty: number }[]): number {
  return roundQty(lines.reduce((sum, line) => sum + line.qty, 0));
}

/** Today is taken in Asia/Dubai (UTC+4, no DST). */
function assertNotFuture(asOfDate: string): void {
  const today = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (asOfDate.slice(0, 10) > today) {
    throw new BadRequestException('The as-of date cannot be in the future');
  }
}

function assertNotCancelled(doc: OpeningStockDocument, action: string): void {
  if (doc.status === VoucherStatus.CANCELLED) {
    throw new BadRequestException(`${LABEL} ${doc.voucherNo} is cancelled and cannot be ${action}`);
  }
}

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) {
    throw new BadRequestException(`${LABEL} id "${id}" is not a valid id`);
  }
}

/** A date-only filter bound covers the whole day. */
function endOfDayIfDateOnly(value: string): Date {
  const date = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}
