import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import {
  STOCK_COUNT_ENTITY_TYPE,
  StockCount,
  StockCountDocument,
  StockCountStatus,
  type StockCountLine,
} from './schemas/stock-count.schema.js';
import {
  ApproveStockCountDto,
  CancelStockCountDto,
  CreateStockCountDto,
  LoadStockCountDto,
  RejectStockCountDto,
  StockCountQueryDto,
  UpdateStockCountDto,
  ValidateStockCountDto,
} from './dto/stock-count.dto.js';
import { STOCK_PRODUCT_TYPES, StockService, roundQty, stockLocationScope, type StockEntryInput } from '../stock.service.js';
import { StockBalance, StockBalanceDocument } from '../schemas/stock-balance.schema.js';
import { Product, ProductDocument, ProductStatus } from '../../product/products/schemas/product.schema.js';
import { ProductService } from '../../product/products/product.service.js';
import { Unit, UnitDocument } from '../../product/units/schemas/unit.schema.js';
import { Location, LocationDocument } from '../../location/schemas/location.schema.js';
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
import { round2 } from '../../../common/utils/money.util.js';
import { renderPdf } from '../../../common/pdf/pdf-renderer.js';

type Viewer = AuthenticatedUser;

const SEQUENCE = { key: 'stock-count', prefix: 'SC-', width: 4 };
const LABEL = 'Stock count';

interface LineInput {
  productId?: string;
  productCode?: string;
  countedQty?: number | null;
  reason?: string | null;
}

export interface CheckedLine {
  row: number;
  productCode: string | null;
  productId: string | null;
  productName: string | null;
  countedQty: number | null;
  reason: string | null;
  snapshotQty: number | null;
}

export interface RowError {
  row: number;
  productCode: string | null;
  message: string;
}

interface ProductInfo {
  code: string;
  name: string;
  unit: string | null;
  cost: number;
}

interface Sheet {
  title: string;
  header: string[];
  widths: (number | string)[];
  head: string[];
  rows: string[][];
}

/**
 * Stock counts: draft (creator edits) -> submitted -> approved (posts
 * countedQty - snapshotQty per line through StockService in one transaction)
 * or rejected. Cancelling an approved count reverses strictly. Users without
 * stock:view-system-qty never receive snapshot quantities or differences.
 */
@Injectable()
export class StockCountService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(StockCount.name) private readonly model: Model<StockCountDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Unit.name) private readonly unitModel: Model<UnitDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    @InjectModel(StockBalance.name) private readonly balanceModel: Model<StockBalanceDocument>,
    private readonly stockService: StockService,
    private readonly productService: ProductService,
    private readonly sequenceService: SequenceService,
    private readonly auditService: AuditService,
    private readonly commentsService: CommentsService,
    entityAccess: EntityAccessRegistry,
  ) {
    entityAccess.register(STOCK_COUNT_ENTITY_TYPE, {
      exists: async (id, user) => Boolean(await this.model.exists(withScope({ _id: id }, scopeOf(user))).exec()),
      canRead: (user) => hasPermission(user, Permission.STOCK_COUNTS_READ),
    });
  }

  async findAll(query: StockCountQueryDto = {}, viewer?: Viewer) {
    const filter: Record<string, unknown> = {};
    if (query.dateFrom || query.dateTo) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) range.$gte = new Date(query.dateFrom);
      if (query.dateTo) range.$lte = endOfDayIfDateOnly(query.dateTo);
      filter.date = range;
    }
    if (query.status) filter.status = query.status;
    if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
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
        .sort({ date: -1, voucherNo: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
      this.model.countDocuments(scoped).exec(),
    ]);
    const [comments, locations] = await Promise.all([
      this.commentsService.countByEntityIds(
        STOCK_COUNT_ENTITY_TYPE,
        docs.map((doc) => doc._id),
      ),
      this.locationNames(docs.map((doc) => doc.locationId)),
    ]);
    return {
      items: docs.map((doc) => ({
        id: doc._id.toString(),
        voucherNo: doc.voucherNo,
        date: doc.date,
        location: { id: doc.locationId.toString(), name: locations.get(doc.locationId.toString()) ?? null },
        status: doc.status,
        lineCount: doc.lines.length,
        createdBy: userRefOf(doc.createdBy as UserSnapshot | null),
        createdAt: doc.createdAt ?? null,
        submittedBy: userRefOf(doc.submittedBy as UserSnapshot | null),
        commentCount: comments.get(doc._id.toString()) ?? 0,
      })),
      page,
      pageSize,
      summary: { count },
    };
  }

  async findById(id: string, viewer: Viewer) {
    assertValidId(id);
    const doc = await this.model.findOne(withScope({ _id: new Types.ObjectId(id) }, scopeOf(viewer))).exec();
    if (!doc) throw new NotFoundException(`${LABEL} ${id} not found`);
    return this.view(doc, viewer);
  }

  /** Lines by product code, resolved and checked like a save would; nothing is saved. */
  async validate(dto: ValidateStockCountDto, viewer: Viewer) {
    if (dto.locationId) {
      assertLocationAllowed(viewer, dto.locationId);
      await this.stockService.assertHoldsStock([], [dto.locationId]);
    }
    const { lines, errors } = await this.check(dto.lines, dto.locationId ?? null);
    const canSystem = hasPermission(viewer, Permission.STOCK_VIEW_SYSTEM_QTY);
    return {
      valid: errors.length === 0,
      errors,
      lines: lines.map(({ snapshotQty, ...line }) => ({ ...line, ...(canSystem ? { snapshotQty } : {}) })),
    };
  }

  async create(dto: CreateStockCountDto, actor: Viewer) {
    assertNotFuture(dto.date);
    assertLocationAllowed(actor, dto.locationId);

    const doc = await runInTransaction(this.connection, async (session) => {
      const lines = await this.checkedLines(dto.lines ?? [], dto.locationId, null, session);
      const voucherNo = await this.sequenceService.nextCode(SEQUENCE, session);
      const now = new Date();
      const [created] = await this.model.create(
        [
          {
            voucherNo,
            date: new Date(dto.date),
            locationId: new Types.ObjectId(dto.locationId),
            comments: dto.comments,
            status: StockCountStatus.DRAFT,
            lines,
            snapshotAt: now,
            createdBy: toUserSnapshot(actor),
            createdAt: now,
          },
        ],
        { session },
      );
      await this.record(created, AuditAction.CREATED, actor, now, session);
      return created;
    });
    return this.view(doc, actor);
  }

  /** Draft only, by its creator. New products take the current balance as snapshot; kept ones keep theirs. */
  async update(id: string, dto: UpdateStockCountDto, actor: Viewer) {
    if (dto.date !== undefined) assertNotFuture(dto.date);
    if (dto.locationId !== undefined) assertLocationAllowed(actor, dto.locationId);

    const doc = await runInTransaction(this.connection, async (session) => {
      const existing = await this.loadDoc(id, scopeOf(actor), session);
      assertEditableDraft(existing, actor);
      const nextLocationId = dto.locationId ?? existing.locationId.toString();
      const locationChanged = nextLocationId !== existing.locationId.toString();
      const lines =
        dto.lines || locationChanged
          ? await this.checkedLines(
              dto.lines ?? existing.lines.map(toInput),
              nextLocationId,
              locationChanged ? null : existing.lines,
              session,
            )
          : existing.lines;
      const next = {
        date: dto.date !== undefined ? new Date(dto.date) : existing.date,
        locationId: nextLocationId,
        comments: dto.comments !== undefined ? dto.comments : existing.comments,
        lines,
      };
      const changes = await this.diff(existing, next, session);
      if (changes.length === 0) throw new BadRequestException('No changes to save');

      const now = new Date();
      if (locationChanged || lines.some((line) => !existing.lines.some((old) => old.productId.equals(line.productId)))) {
        existing.snapshotAt = now;
      }
      existing.date = next.date;
      existing.locationId = new Types.ObjectId(nextLocationId);
      existing.comments = next.comments;
      existing.lines = next.lines;
      existing.updatedBy = toUserSnapshot(actor);
      existing.updatedAt = now;
      await existing.save({ session });
      await this.record(existing, AuditAction.UPDATED, actor, now, session, { changes });
      return existing;
    });
    return this.view(doc, actor);
  }

  /** Adds every active stock/bundle product (optionally one group, optionally only those holding stock) not yet on the count. */
  async loadProducts(id: string, dto: LoadStockCountDto, actor: Viewer) {
    const groupIds = dto.groupId ? await this.productService.groupWithDescendants(dto.groupId) : null;
    const doc = await runInTransaction(this.connection, async (session) => {
      const existing = await this.loadDoc(id, scopeOf(actor), session);
      assertEditableDraft(existing, actor);
      const products = await this.productModel
        .find({
          type: { $in: STOCK_PRODUCT_TYPES },
          status: ProductStatus.ACTIVE,
          _id: { $nin: existing.lines.map((line) => line.productId) },
          ...(groupIds ? { productGroupId: { $in: groupIds } } : {}),
        })
        .select('_id')
        .sort({ code: 1 })
        .session(session)
        .lean()
        .exec();
      const balances = await this.balances(existing.locationId, products.map((product) => product._id), session);
      const added = products
        .map((product) => ({ productId: product._id, snapshotQty: balances.get(product._id.toString()) ?? 0 }))
        .filter((line) => !dto.onlyWithStock || line.snapshotQty !== 0)
        .map((line) => ({ ...line, countedQty: null, reason: null, movedSinceCount: false }));
      if (added.length === 0) throw new BadRequestException('No products to add');

      const now = new Date();
      existing.lines = [...existing.lines, ...added];
      existing.snapshotAt = now;
      existing.updatedBy = toUserSnapshot(actor);
      existing.updatedAt = now;
      await existing.save({ session });
      await this.record(existing, AuditAction.UPDATED, actor, now, session, {
        changes: [{ field: 'lines', label: 'Products loaded', from: null, to: `${added.length} added` }],
      });
      return existing;
    });
    return this.view(doc, actor);
  }

  async submit(id: string, actor: Viewer) {
    const doc = await runInTransaction(this.connection, async (session) => {
      const existing = await this.loadDoc(id, scopeOf(actor), session);
      assertEditableDraft(existing, actor);
      if (existing.lines.length === 0) throw new BadRequestException('Add at least one product before submitting');
      const uncounted = existing.lines.filter((line) => line.countedQty === null);
      if (uncounted.length > 0) {
        const info = await this.productInfo(uncounted.map((line) => line.productId), session);
        throw new BadRequestException(
          `Every line must be counted. Missing: ${uncounted.map((line) => info.get(line.productId.toString())?.code).join(', ')}`,
        );
      }
      const now = new Date();
      existing.status = StockCountStatus.SUBMITTED;
      existing.submittedBy = toUserSnapshot(actor);
      existing.submittedAt = now;
      await existing.save({ session });
      await this.record(existing, AuditAction.SUBMITTED, actor, now, session, {
        changes: [statusChange(StockCountStatus.DRAFT, StockCountStatus.SUBMITTED)],
      });
      return existing;
    });
    return this.view(doc, actor);
  }

  /** Posts countedQty - snapshotQty per line; movement since the snapshot is kept but must be acknowledged. */
  async approve(id: string, dto: ApproveStockCountDto, actor: Viewer) {
    const doc = await runInTransaction(this.connection, async (session) => {
      const existing = await this.loadDoc(id, scopeOf(actor), session);
      assertSubmitted(existing, 'approved');
      assertNotSubmitter(existing, actor, 'approve');

      const balances = await this.balances(existing.locationId, existing.lines.map((line) => line.productId), session);
      for (const line of existing.lines) {
        line.movedSinceCount = roundQty(balances.get(line.productId.toString()) ?? 0) !== roundQty(line.snapshotQty);
      }
      const moved = existing.lines.filter((line) => line.movedSinceCount);
      if (moved.length > 0 && !dto.acknowledgeMoved) {
        const info = await this.productInfo(moved.map((line) => line.productId), session);
        throw new BadRequestException(
          `Stock moved since the count for ${moved
            .map((line) => info.get(line.productId.toString())?.code)
            .join(', ')}: set acknowledgeMoved to approve`,
        );
      }
      const now = new Date();
      existing.status = StockCountStatus.APPROVED;
      existing.approvedBy = toUserSnapshot(actor);
      existing.approvedAt = now;
      await existing.save({ session });
      await this.stockService.post(this.entriesOf(existing, now), actor, session);
      await this.record(existing, AuditAction.APPROVED, actor, now, session, {
        changes: [statusChange(StockCountStatus.SUBMITTED, StockCountStatus.APPROVED)],
      });
      return existing;
    });
    return this.view(doc, actor);
  }

  async reject(id: string, dto: RejectStockCountDto, actor: Viewer) {
    const reason = dto.reason.trim();
    const doc = await runInTransaction(this.connection, async (session) => {
      const existing = await this.loadDoc(id, scopeOf(actor), session);
      assertSubmitted(existing, 'rejected');
      assertNotSubmitter(existing, actor, 'reject');
      const now = new Date();
      existing.status = StockCountStatus.REJECTED;
      existing.rejectedBy = toUserSnapshot(actor);
      existing.rejectedAt = now;
      existing.rejectReason = reason;
      await existing.save({ session });
      await this.record(existing, AuditAction.REJECTED, actor, now, session, {
        changes: [statusChange(StockCountStatus.SUBMITTED, StockCountStatus.REJECTED)],
        reason,
      });
      return existing;
    });
    return this.view(doc, actor);
  }

  /** An approved count's entries are reversed strictly (refused if a balance would go below zero). */
  async cancel(id: string, dto: CancelStockCountDto, actor: Viewer) {
    const reason = dto.reason.trim();
    const doc = await runInTransaction(this.connection, async (session) => {
      const existing = await this.loadDoc(id, scopeOf(actor), session);
      if (existing.status === StockCountStatus.CANCELLED || existing.status === StockCountStatus.REJECTED) {
        throw new BadRequestException(`${LABEL} ${existing.voucherNo} is ${existing.status} and cannot be cancelled`);
      }
      const from = existing.status;
      if (from === StockCountStatus.APPROVED) {
        await this.stockService.post(
          await this.stockService.reversalsOf(STOCK_COUNT_ENTITY_TYPE, existing._id, session),
          actor,
          session,
          { strict: true },
        );
      }
      const now = new Date();
      existing.status = StockCountStatus.CANCELLED;
      existing.cancelledBy = toUserSnapshot(actor);
      existing.cancelledAt = now;
      existing.cancelReason = reason;
      await existing.save({ session });
      await this.record(existing, AuditAction.CANCELLED, actor, now, session, {
        changes: [statusChange(from, StockCountStatus.CANCELLED)],
        reason,
      });
      return existing;
    });
    return this.view(doc, actor);
  }

  /** STOCK COUNT SHEET: always blind (product, unit, blank count column). */
  sheetPdf(id: string, viewer: Viewer) {
    return this.print(id, viewer, false, (doc, info, location) => ({
      title: 'STOCK COUNT SHEET',
      header: [`No: ${doc.voucherNo}`, `Date: ${doc.date.toISOString().slice(0, 10)}`, `Location: ${location}`],
      widths: [24, 70, '*', 50, 90],
      head: ['#', 'Code', 'Product', 'Unit', 'Counted'],
      rows: doc.lines.map((line, index) => {
        const product = info.get(line.productId.toString());
        return [String(index + 1), product?.code ?? '', product?.name ?? '', product?.unit ?? '', ' '];
      }),
    }));
  }

  /** Adjustment summary of an approved count; needs stock:view-system-qty, values also products:view-cost. */
  adjustmentPdf(id: string, viewer: Viewer) {
    if (!hasPermission(viewer, Permission.STOCK_VIEW_SYSTEM_QTY)) {
      throw new ForbiddenException('You may not see system quantities');
    }
    const canCost = hasPermission(viewer, Permission.PRODUCTS_VIEW_COST);
    return this.print(id, viewer, true, (doc, info, location) => ({
      title: 'STOCK ADJUSTMENT SUMMARY',
      header: [`No: ${doc.voucherNo}`, `Date: ${doc.date.toISOString().slice(0, 10)}`, `Location: ${location}`],
      widths: canCost ? [70, '*', 45, 45, 45, 55] : [70, '*', 55, 55, 55],
      head: ['Code', 'Product', 'System', 'Counted', 'Diff', ...(canCost ? ['Value'] : [])],
      rows: doc.lines.map((line) => {
        const product = info.get(line.productId.toString());
        const diff = roundQty((line.countedQty ?? 0) - line.snapshotQty);
        return [
          product?.code ?? '',
          product?.name ?? '',
          String(line.snapshotQty),
          String(line.countedQty ?? ''),
          String(diff),
          ...(canCost ? [round2(diff * (product?.cost ?? 0)).toFixed(2)] : []),
        ];
      }),
    }));
  }

  /** Renders the PDF and records the print in one transaction. */
  private async print(
    id: string,
    viewer: Viewer,
    approvedOnly: boolean,
    build: (doc: StockCountDocument, info: Map<string, ProductInfo>, location: string) => Sheet,
  ): Promise<{ buffer: Buffer; filename: string }> {
    assertValidId(id);
    return runInTransaction(this.connection, async (session) => {
      const doc = await this.model
        .findOneAndUpdate(
          withScope({ _id: new Types.ObjectId(id) }, scopeOf(viewer)),
          { $inc: { printCount: 1 } },
          { returnDocument: 'after', session },
        )
        .exec();
      if (!doc) throw new NotFoundException(`${LABEL} ${id} not found`);
      if (approvedOnly && doc.status !== StockCountStatus.APPROVED) {
        throw new BadRequestException(`${LABEL} ${doc.voucherNo} is not approved`);
      }
      const info = await this.productInfo(doc.lines.map((line) => line.productId), session);
      const location = (await this.locationNames([doc.locationId], session)).get(doc.locationId.toString()) ?? '';
      const sheet = build(doc, info, location);
      const definition: TDocumentDefinitions = {
        info: { title: `${sheet.title} ${doc.voucherNo}` },
        pageSize: 'A4',
        content: [
          { text: sheet.title, fontSize: 16, bold: true, margin: [0, 0, 0, 6] },
          { text: sheet.header.join('   '), margin: [0, 0, 0, 10] },
          {
            table: {
              headerRows: 1,
              widths: sheet.widths,
              body: [sheet.head.map((text) => ({ text, bold: true })), ...sheet.rows],
            },
          },
        ] as Content[],
        defaultStyle: { fontSize: 9 },
      };
      const buffer = await renderPdf(definition);
      await this.record(doc, AuditAction.PRINTED, viewer, new Date(), session);
      return { buffer, filename: `${doc.voucherNo}.pdf` };
    });
  }

  /** API shape; snapshot, difference, moved flag and values only for those allowed to see them. */
  private async view(doc: StockCountDocument, viewer: Viewer) {
    const canSystem = hasPermission(viewer, Permission.STOCK_VIEW_SYSTEM_QTY);
    const canCost = hasPermission(viewer, Permission.PRODUCTS_VIEW_COST);
    const productIds = doc.lines.map((line) => line.productId);
    const info = await this.productInfo(productIds);
    const live = canSystem && doc.status === StockCountStatus.SUBMITTED ? await this.balances(doc.locationId, productIds) : null;
    const location = (await this.locationNames([doc.locationId])).get(doc.locationId.toString()) ?? null;
    let excessQty = 0;
    let shortageQty = 0;
    let excessValue = 0;
    let shortageValue = 0;
    const lines = doc.lines.map((line) => {
      const product = info.get(line.productId.toString());
      const base = {
        productId: line.productId.toString(),
        productCode: product?.code ?? null,
        productName: product?.name ?? null,
        unit: product?.unit ?? null,
        countedQty: line.countedQty,
        reason: line.reason,
      };
      if (!canSystem) return base;
      const difference = line.countedQty === null ? null : roundQty(line.countedQty - line.snapshotQty);
      const value = difference === null ? 0 : round2(difference * (product?.cost ?? 0));
      if (difference !== null && difference > 0) {
        excessQty += difference;
        excessValue += value;
      } else if (difference !== null && difference < 0) {
        shortageQty -= difference;
        shortageValue -= value;
      }
      return {
        ...base,
        snapshotQty: line.snapshotQty,
        difference,
        movedSinceCount: live
          ? roundQty(live.get(line.productId.toString()) ?? 0) !== roundQty(line.snapshotQty)
          : line.movedSinceCount,
        ...(canCost ? { value } : {}),
      };
    });
    return {
      id: doc._id.toString(),
      voucherNo: doc.voucherNo,
      date: doc.date,
      location: { id: doc.locationId.toString(), name: location },
      comments: doc.comments ?? null,
      status: doc.status,
      snapshotAt: doc.snapshotAt,
      lines,
      ...(canSystem
        ? {
            totals: {
              excessQty: roundQty(excessQty),
              shortageQty: roundQty(shortageQty),
              ...(canCost ? { excessValue: round2(excessValue), shortageValue: round2(shortageValue) } : {}),
            },
          }
        : {}),
      createdBy: userRefOf(doc.createdBy as UserSnapshot | null),
      createdAt: doc.createdAt ?? null,
      updatedBy: userRefOf(doc.updatedBy as UserSnapshot | null),
      updatedAt: doc.updatedAt ?? null,
      submittedBy: userRefOf(doc.submittedBy as UserSnapshot | null),
      submittedAt: doc.submittedAt ?? null,
      approvedBy: userRefOf(doc.approvedBy as UserSnapshot | null),
      approvedAt: doc.approvedAt ?? null,
      rejectedBy: userRefOf(doc.rejectedBy as UserSnapshot | null),
      rejectedAt: doc.rejectedAt ?? null,
      rejectReason: doc.rejectReason,
      cancelledBy: userRefOf(doc.cancelledBy as UserSnapshot | null),
      cancelledAt: doc.cancelledAt ?? null,
      cancelReason: doc.cancelReason,
    };
  }

  private entriesOf(doc: StockCountDocument, date: Date): StockEntryInput[] {
    return doc.lines.map((line) => ({
      productId: line.productId,
      locationId: doc.locationId,
      qty: roundQty((line.countedQty ?? 0) - line.snapshotQty),
      date,
      voucherType: STOCK_COUNT_ENTITY_TYPE,
      voucherId: doc._id,
      voucherNo: doc.voucherNo,
    }));
  }

  /** Current balances at a location, by product id. */
  private async balances(locationId: Types.ObjectId, productIds: Types.ObjectId[], session?: ClientSession) {
    const rows = await this.balanceModel
      .find({ locationId, productId: { $in: productIds } })
      .session(session ?? null)
      .lean()
      .exec();
    return new Map(rows.map((row) => [row.productId.toString(), roundQty(row.qty)]));
  }

  private async productInfo(ids: Types.ObjectId[], session?: ClientSession): Promise<Map<string, ProductInfo>> {
    const products = await this.productModel
      .find({ _id: { $in: ids } })
      .select('code name unitId purchasePrice')
      .session(session ?? null)
      .lean()
      .exec();
    const units = await this.unitModel
      .find({ _id: { $in: products.map((product) => product.unitId) } })
      .select('symbol')
      .session(session ?? null)
      .lean()
      .exec();
    const symbol = new Map(units.map((unit) => [unit._id.toString(), unit.symbol]));
    return new Map(
      products.map((product) => [
        product._id.toString(),
        {
          code: product.code,
          name: product.name,
          unit: symbol.get(product.unitId.toString()) ?? null,
          cost: product.purchasePrice ?? 0,
        },
      ]),
    );
  }

  /** Lines as stored; a row error rejects the save with every row's message. Kept products keep their snapshot. */
  private async checkedLines(
    inputs: readonly LineInput[],
    locationId: string,
    keep: readonly StockCountLine[] | null,
    session: ClientSession,
  ): Promise<StockCountLine[]> {
    await this.stockService.assertHoldsStock([], [locationId], session);
    const { lines, errors } = await this.check(inputs, locationId, session);
    if (errors.length > 0) {
      throw new BadRequestException(errors.map((error) => `Line ${error.row}: ${error.message}`).join('; '));
    }
    return lines.map((line) => {
      const productId = new Types.ObjectId(line.productId!);
      const kept = keep?.find((old) => old.productId.equals(productId));
      return {
        productId,
        snapshotQty: kept ? kept.snapshotQty : (line.snapshotQty ?? 0),
        countedQty: line.countedQty,
        reason: line.reason,
        movedSinceCount: false,
      };
    });
  }

  /** Resolves each row's product (id or code): unknown, non-stock, repeated, or a negative count are row errors. */
  private async check(
    inputs: readonly LineInput[],
    locationId: string | null,
    session?: ClientSession,
  ): Promise<{ lines: CheckedLine[]; errors: RowError[] }> {
    const ids = inputs.flatMap((input) => (input.productId && Types.ObjectId.isValid(input.productId) ? [input.productId] : []));
    const codes = inputs.flatMap((input) => (input.productCode ? [input.productCode.trim().toUpperCase()] : []));
    const products = await this.productModel
      .find({ $or: [{ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }, { code: { $in: codes } }] })
      .select('code name type')
      .session(session ?? null)
      .lean()
      .exec();
    const balances = locationId
      ? await this.balances(new Types.ObjectId(locationId), products.map((product) => product._id), session)
      : null;

    const errors: RowError[] = [];
    const seen = new Set<string>();
    const lines = inputs.map((input, index): CheckedLine => {
      const row = index + 1;
      const product =
        products.find((candidate) =>
          input.productCode
            ? candidate.code === input.productCode.trim().toUpperCase()
            : candidate._id.toString() === input.productId,
        ) ?? null;
      const fail = (message: string) =>
        errors.push({ row, productCode: product?.code ?? input.productCode ?? null, message });
      const countedQty = input.countedQty == null ? null : roundQty(input.countedQty);

      if (!product) {
        fail(input.productCode ? `Unknown product code "${input.productCode}"` : `Product ${input.productId} not found`);
      } else {
        const name = `${product.code} (${product.name})`;
        if (!STOCK_PRODUCT_TYPES.includes(product.type)) fail(`${name} is a ${product.type} product and holds no stock`);
        const id = product._id.toString();
        if (seen.has(id)) fail(`${name} is on more than one line`);
        seen.add(id);
      }
      if (countedQty !== null && countedQty < 0) fail('Counted quantity cannot be negative');

      return {
        row,
        productCode: product?.code ?? input.productCode ?? null,
        productId: product?._id.toString() ?? null,
        productName: product?.name ?? null,
        countedQty,
        reason: input.reason?.trim() || null,
        snapshotQty: product && balances ? (balances.get(product._id.toString()) ?? 0) : null,
      };
    });
    return { lines, errors };
  }

  /** Field diff for the audit: date, location, comments, and each product's count. */
  private async diff(
    before: StockCountDocument,
    after: { date: Date; locationId: string; comments?: string; lines: readonly StockCountLine[] },
    session: ClientSession,
  ): Promise<AuditChange[]> {
    const changes: AuditChange[] = [];
    const day = (date: Date) => date.toISOString().slice(0, 10);
    if (day(before.date) !== day(after.date)) {
      changes.push({ field: 'date', label: 'Date', from: day(before.date), to: day(after.date) });
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
    const describe = (lines: readonly StockCountLine[]) =>
      new Map(
        lines.map((line) => [
          line.productId.toString(),
          `${line.countedQty ?? 'not counted'}${line.reason ? ` (${line.reason})` : ''}`,
        ]),
      );
    const from = describe(before.lines);
    const to = describe(after.lines);
    const productIds = [...new Set([...from.keys(), ...to.keys()])].filter((id) => from.get(id) !== to.get(id));
    const info = await this.productInfo(
      productIds.map((id) => new Types.ObjectId(id)),
      session,
    );
    for (const productId of productIds) {
      changes.push({
        field: 'lines',
        label: info.get(productId)?.name ?? productId,
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

  private async loadDoc(id: string, scope: Record<string, unknown> | null, session: ClientSession) {
    assertValidId(id);
    const doc = await this.model
      .findOne(withScope({ _id: new Types.ObjectId(id) }, scope))
      .session(session)
      .exec();
    if (!doc) throw new NotFoundException(`${LABEL} ${id} not found`);
    return doc;
  }

  private record(
    doc: StockCountDocument,
    action: AuditAction,
    actor: Viewer,
    at: Date,
    session: ClientSession,
    extra: { changes?: AuditChange[]; reason?: string } = {},
  ) {
    return this.auditService.record(
      { entityType: STOCK_COUNT_ENTITY_TYPE, entityId: doc._id, entityRef: doc.voucherNo, action, actor, at, ...extra },
      session,
    );
  }
}

/** "own"-scoped users: only counts at their allowed locations. */
function scopeOf(user: Viewer | undefined): Record<string, unknown> | null {
  const allowed = stockLocationScope(user);
  return allowed ? { locationId: { $in: allowed.map((id) => new Types.ObjectId(id)) } } : null;
}

function assertLocationAllowed(user: Viewer, locationId: string): void {
  const allowed = stockLocationScope(user);
  if (allowed && !allowed.includes(locationId)) {
    throw new ForbiddenException('You may not count stock at this location');
  }
}

function toInput(line: StockCountLine): LineInput {
  return { productId: line.productId.toString(), countedQty: line.countedQty, reason: line.reason };
}

function statusChange(from: StockCountStatus, to: StockCountStatus): AuditChange {
  return { field: 'status', label: 'Status', from, to };
}

/** Only the creator edits or submits, and only while it is a draft. */
function assertEditableDraft(doc: StockCountDocument, actor: Viewer): void {
  if (doc.status !== StockCountStatus.DRAFT) {
    throw new BadRequestException(`${LABEL} ${doc.voucherNo} is ${doc.status}: only a draft can be changed`);
  }
  if (doc.createdBy?.id.toString() !== actor.id) {
    throw new ForbiddenException('Only the creator may change this draft');
  }
}

function assertSubmitted(doc: StockCountDocument, action: string): void {
  if (doc.status !== StockCountStatus.SUBMITTED) {
    throw new BadRequestException(`${LABEL} ${doc.voucherNo} is ${doc.status} and cannot be ${action}`);
  }
}

function assertNotSubmitter(doc: StockCountDocument, actor: Viewer, action: string): void {
  if (doc.submittedBy?.id.toString() === actor.id) {
    throw new ForbiddenException(`You cannot ${action} a count you submitted`);
  }
}

/** Today is taken in Asia/Dubai (UTC+4, no DST). */
function assertNotFuture(date: string): void {
  const today = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (date.slice(0, 10) > today) {
    throw new BadRequestException('The count date cannot be in the future');
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
