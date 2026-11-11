import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import {
  STOCK_TRANSFER_ENTITY_TYPE,
  StockTransfer,
  StockTransferDocument,
  type StockTransferLine,
} from './schemas/stock-transfer.schema.js';
import {
  CancelStockTransferDto,
  CreateStockTransferDto,
  ReceiveStockTransferDto,
  StockTransferLineDto,
  StockTransferQueryDto,
  UpdateStockTransferDto,
} from './dto/stock-transfer.dto.js';
import { StockService, roundQty, stockLocationScope, type StockEntryInput } from '../stock.service.js';
import { InTransitRegistry, PendingReceiptStatus, splitReceipt } from '../pending-receipt.js';
import { Product, ProductDocument } from '../../product/products/schemas/product.schema.js';
import { ProductUsageRegistry } from '../../product/products/product-usage.registry.js';
import { Location, LocationDocument } from '../../location/schemas/location.schema.js';
import { withScope } from '../../accounting/vouchers/data-scope.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { escapeRegExp } from '../../sequence/code-sequence.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction, type AuditChange } from '../../audit/schemas/audit-log.schema.js';
import { CommentsService } from '../../comments/comments.service.js';
import { EntityAccessRegistry } from '../../comments/entity-access.registry.js';
import { ADMIN_ROLE_NAME, Permission, hasPermission } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { type UserSnapshot, toUserSnapshot, userRefOf } from '../../../common/schemas/user-snapshot.schema.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';
import { renderPdf } from '../../../common/pdf/pdf-renderer.js';

type Viewer = AuthenticatedUser;

const SEQUENCE = { key: 'stock-transfer', prefix: 'TR-', width: 4 };
const LABEL = 'Stock transfer';

/**
 * Two-step stock transfers. Send posts negative entries at the source in one
 * transaction with its number and audit entry (status in_transit); receive
 * posts what arrived at the destination and any shortfall back at the source.
 * Edit (reverse + repost) and cancel (reverse) only while in transit.
 * "own"-scoped users see transfers touching their allowedLocationIds, send
 * only from them and receive only into them (never their own).
 */
@Injectable()
export class StockTransferService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(StockTransfer.name) private readonly model: Model<StockTransferDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    private readonly stockService: StockService,
    private readonly sequenceService: SequenceService,
    private readonly auditService: AuditService,
    private readonly commentsService: CommentsService,
    entityAccess: EntityAccessRegistry,
    productUsage: ProductUsageRegistry,
    inTransit: InTransitRegistry,
  ) {
    entityAccess.register(STOCK_TRANSFER_ENTITY_TYPE, {
      exists: async (id, user) => Boolean(await this.model.exists(withScope({ _id: id }, scopeOf(user))).exec()),
      canRead: (user) => hasPermission(user, Permission.STOCK_TRANSFERS_READ),
    });
    productUsage.register('stock transfers', async (productId, session) =>
      Boolean(
        await this.model
          .exists({ 'lines.productId': productId })
          .session(session ?? null)
          .exec(),
      ),
    );
    inTransit.register('stock transfers', async (productIds, toLocationIds) => {
      const rows = await this.model
        .aggregate<{ _id: Types.ObjectId; qty: number }>([
          {
            $match: {
              status: PendingReceiptStatus.IN_TRANSIT,
              'lines.productId': { $in: productIds },
              ...(toLocationIds ? { toLocationId: { $in: toLocationIds } } : {}),
            },
          },
          { $unwind: '$lines' },
          { $match: { 'lines.productId': { $in: productIds } } },
          { $group: { _id: '$lines.productId', qty: { $sum: '$lines.qty' } } },
        ])
        .exec();
      return new Map(rows.map((row) => [row._id.toString(), roundQty(row.qty)]));
    });
  }

  async findAll(query: StockTransferQueryDto = {}, viewer?: Viewer) {
    const filter: Record<string, unknown> = {};
    if (query.dateFrom || query.dateTo) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (query.dateFrom) range.$gte = new Date(query.dateFrom);
      if (query.dateTo) range.$lte = endOfDayIfDateOnly(query.dateTo);
      filter.date = range;
    }
    if (query.status) filter.status = query.status;
    if (query.fromLocationId) filter.fromLocationId = new Types.ObjectId(query.fromLocationId);
    if (query.toLocationId) filter.toLocationId = new Types.ObjectId(query.toLocationId);
    if (query.productId) filter['lines.productId'] = new Types.ObjectId(query.productId);
    if (query.receivableByMe && viewer) filter.$and = [receivableByFilter(viewer)];
    const term = query.q?.trim();
    if (term) {
      const pattern = new RegExp(escapeRegExp(term), 'i');
      const products = await this.productModel
        .find({ $or: [{ name: pattern }, { code: pattern }] })
        .select('_id')
        .lean()
        .exec();
      filter.$or = [{ voucherNo: pattern }, { comments: pattern }, { 'lines.productId': { $in: products.map((p) => p._id) } }];
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
        STOCK_TRANSFER_ENTITY_TYPE,
        docs.map((doc) => doc._id),
      ),
      this.locationNames(docs.flatMap((doc) => [doc.fromLocationId, doc.toLocationId])),
    ]);
    const place = (id: Types.ObjectId) => ({ id: id.toString(), name: locations.get(id.toString()) ?? null });
    return {
      items: docs.map((doc) => ({
        id: doc._id.toString(),
        voucherNo: doc.voucherNo,
        date: doc.date,
        from: place(doc.fromLocationId),
        to: place(doc.toLocationId),
        lineCount: doc.lines.length,
        totalQty: doc.totalQty,
        status: doc.status,
        sentBy: userRefOf(doc.sentBy as UserSnapshot | null),
        sentAt: doc.sentAt ?? null,
        receivedBy: userRefOf(doc.receivedBy as UserSnapshot | null),
        receivedAt: doc.receivedAt ?? null,
        commentCount: comments.get(doc._id.toString()) ?? 0,
      })),
      page,
      pageSize,
      summary: { count },
    };
  }

  async findById(id: string, viewer?: Viewer): Promise<StockTransferDocument> {
    assertValidId(id);
    const doc = await this.model.findOne(withScope({ _id: new Types.ObjectId(id) }, scopeOf(viewer))).exec();
    if (!doc) throw new NotFoundException(`${LABEL} ${id} not found`);
    return doc;
  }

  /** In-transit transfers this user can receive (scoped: into their locations, not their own). For the menu badge. */
  async toReceiveCount(viewer: Viewer): Promise<{ count: number }> {
    const count = await this.model.countDocuments(receivableByFilter(viewer)).exec();
    return { count };
  }

  /** Send: stock leaves the source now (negative-stock rule applies). */
  async create(dto: CreateStockTransferDto, actor: Viewer): Promise<StockTransferDocument> {
    assertNotFuture(dto.date);
    assertFromAllowed(actor, dto.fromLocationId);
    assertDifferent(dto.fromLocationId, dto.toLocationId);

    return runInTransaction(this.connection, async (session) => {
      const lines = await this.checkedLines(dto.lines, dto.fromLocationId, dto.toLocationId, session);
      const voucherNo = await this.sequenceService.nextCode(SEQUENCE, session);
      const now = new Date();
      const [created] = await this.model.create(
        [
          {
            voucherNo,
            date: new Date(dto.date),
            fromLocationId: new Types.ObjectId(dto.fromLocationId),
            toLocationId: new Types.ObjectId(dto.toLocationId),
            comments: dto.comments,
            lines,
            totalQty: totalQtyOf(lines),
            status: PendingReceiptStatus.IN_TRANSIT,
            sentBy: toUserSnapshot(actor),
            sentAt: now,
          },
        ],
        { session },
      );
      await this.stockService.post(this.sendEntries(created), actor, session);
      await this.record(created, AuditAction.CREATED, actor, now, session);
      return created;
    });
  }

  /** Sender or admin, while in transit: reverses the send and posts the new one, so only the net result is checked. */
  async update(id: string, dto: UpdateStockTransferDto, actor: Viewer): Promise<StockTransferDocument> {
    if (dto.date !== undefined) assertNotFuture(dto.date);

    return runInTransaction(this.connection, async (session) => {
      const existing = await this.load(id, scopeOf(actor), session);
      assertInTransit(existing, 'edited');
      if (existing.sentBy?.id.toString() !== actor.id && actor.role?.name !== ADMIN_ROLE_NAME) {
        throw new ForbiddenException('Only the sender or an administrator can edit a transfer');
      }
      const next = {
        date: dto.date !== undefined ? new Date(dto.date) : existing.date,
        fromLocationId: dto.fromLocationId ?? existing.fromLocationId.toString(),
        toLocationId: dto.toLocationId ?? existing.toLocationId.toString(),
        comments: dto.comments !== undefined ? dto.comments : existing.comments,
        lines: [] as StockTransferLine[],
      };
      if (next.fromLocationId !== existing.fromLocationId.toString()) assertFromAllowed(actor, next.fromLocationId);
      assertDifferent(next.fromLocationId, next.toLocationId);
      next.lines = await this.checkedLines(
        dto.lines ?? existing.lines.map((line) => ({ productId: line.productId.toString(), qty: line.qty })),
        next.fromLocationId,
        next.toLocationId,
        session,
      );

      const changes = await this.diff(existing, next, session);
      if (changes.length === 0) throw new BadRequestException('No changes to save');

      const reversals = await this.stockService.reversalsOf(STOCK_TRANSFER_ENTITY_TYPE, existing._id, session);
      const now = new Date();
      existing.date = next.date;
      existing.fromLocationId = new Types.ObjectId(next.fromLocationId);
      existing.toLocationId = new Types.ObjectId(next.toLocationId);
      existing.comments = next.comments;
      existing.lines = next.lines;
      existing.totalQty = totalQtyOf(next.lines);
      existing.updatedBy = toUserSnapshot(actor);
      existing.updatedAt = now;
      await existing.save({ session });
      await this.stockService.post([...reversals, ...this.sendEntries(existing)], actor, session);
      await this.record(existing, AuditAction.UPDATED, actor, now, session, { changes, reason: dto.changeNote });
      return existing;
    });
  }

  /** Receive: what arrived goes into the destination, any shortfall back to the source (reason required). */
  async receive(id: string, dto: ReceiveStockTransferDto, actor: Viewer): Promise<StockTransferDocument> {
    return runInTransaction(this.connection, async (session) => {
      const existing = await this.load(id, scopeOf(actor), session);
      assertInTransit(existing, 'received');
      const allowed = stockLocationScope(actor);
      if (allowed) {
        if (existing.sentBy?.id.toString() === actor.id) {
          throw new ForbiddenException('You cannot receive a transfer you sent');
        }
        if (!allowed.includes(existing.toLocationId.toString())) {
          throw new ForbiddenException('You may not receive stock into this location');
        }
      }

      const requested = new Map<string, number>();
      for (const line of dto.lines ?? []) {
        if (!existing.lines.some((own) => own.productId.toString() === line.productId)) {
          throw new BadRequestException(`Product ${line.productId} is not on ${existing.voucherNo}`);
        }
        if (requested.has(line.productId)) throw new BadRequestException(`Product ${line.productId} is on more than one line`);
        requested.set(line.productId, line.receivedQty);
      }
      const parts = splitReceipt(
        existing.lines.map((line) => ({ sent: line.qty, received: requested.get(line.productId.toString()) ?? line.qty })),
      );
      const short = parts.some((part) => part.shortfall > 0);
      const reason = dto.shortfallReason?.trim();
      if (short && !reason) throw new BadRequestException('A reason is required when less than the sent quantity is received');

      const names = await this.productNames(existing.lines.map((line) => line.productId), session);
      const changes: AuditChange[] = [
        { field: 'status', label: 'Status', from: PendingReceiptStatus.IN_TRANSIT, to: PendingReceiptStatus.RECEIVED },
      ];
      existing.lines.forEach((line, index) => {
        line.receivedQty = parts[index].received;
        if (parts[index].shortfall > 0) {
          changes.push({
            field: 'lines',
            label: names.get(line.productId.toString()) ?? line.productId.toString(),
            from: `sent ${line.qty}`,
            to: `received ${parts[index].received}`,
          });
        }
      });
      const now = new Date();
      existing.status = PendingReceiptStatus.RECEIVED;
      existing.receivedBy = toUserSnapshot(actor);
      existing.receivedAt = now;
      existing.shortfallReason = short ? reason! : null;
      await existing.save({ session });
      await this.stockService.post(this.receiveEntries(existing, now), actor, session);
      await this.record(existing, AuditAction.RECEIVED, actor, now, session, { changes, reason: short ? reason : undefined });
      return existing;
    });
  }

  /** Only while in transit: puts the stock back at the source. */
  async cancel(id: string, dto: CancelStockTransferDto, actor: Viewer): Promise<StockTransferDocument> {
    const reason = dto.reason.trim();

    return runInTransaction(this.connection, async (session) => {
      const existing = await this.load(id, scopeOf(actor), session);
      assertInTransit(existing, 'cancelled');
      await this.stockService.post(
        await this.stockService.reversalsOf(STOCK_TRANSFER_ENTITY_TYPE, existing._id, session),
        actor,
        session,
        { strict: true },
      );
      const now = new Date();
      existing.status = PendingReceiptStatus.CANCELLED;
      existing.cancelledBy = toUserSnapshot(actor);
      existing.cancelledAt = now;
      existing.cancelReason = reason;
      await existing.save({ session });
      await this.record(existing, AuditAction.CANCELLED, actor, now, session, {
        changes: [{ field: 'status', label: 'Status', from: PendingReceiptStatus.IN_TRANSIT, to: PendingReceiptStatus.CANCELLED }],
        reason,
      });
      return existing;
    });
  }

  /** STOCK TRANSFER NOTE with sent/received columns and signature boxes. Every call is audited. */
  async pdf(id: string, viewer: Viewer): Promise<{ buffer: Buffer; filename: string }> {
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
      const products = await this.productModel
        .find({ _id: { $in: doc.lines.map((line) => line.productId) } })
        .select('code name')
        .session(session)
        .lean()
        .exec();
      const info = new Map(products.map((product) => [product._id.toString(), product]));
      const locations = await this.locationNames([doc.fromLocationId, doc.toLocationId], session);
      const day = (date: Date) => date.toISOString().slice(0, 10);
      const rows = doc.lines.map((line) => [
        info.get(line.productId.toString())?.code ?? '',
        info.get(line.productId.toString())?.name ?? '',
        String(line.qty),
        line.receivedQty == null ? '' : String(line.receivedQty),
      ]);
      const signature = (title: string, name?: string | null, at?: Date | null): Content => ({
        stack: [{ text: title, bold: true }, { text: name ? `${name}${at ? `  ${day(at)}` : ''}` : '', margin: [0, 28, 0, 0] }],
      });
      const definition: TDocumentDefinitions = {
        info: { title: `STOCK TRANSFER NOTE ${doc.voucherNo}` },
        pageSize: 'A4',
        content: [
          { text: 'STOCK TRANSFER NOTE', fontSize: 16, bold: true, margin: [0, 0, 0, 6] },
          {
            text: [
              `No: ${doc.voucherNo}`,
              `Date: ${day(doc.date)}`,
              `From: ${locations.get(doc.fromLocationId.toString()) ?? ''}`,
              `To: ${locations.get(doc.toLocationId.toString()) ?? ''}`,
              `Status: ${doc.status.replace('_', ' ').toUpperCase()}`,
            ].join('   '),
            margin: [0, 0, 0, 8],
          },
          {
            table: {
              headerRows: 1,
              widths: [80, '*', 60, 60],
              body: [['Code', 'Product', 'Sent', 'Received'].map((text) => ({ text, bold: true })), ...rows],
            },
          },
          ...(doc.shortfallReason ? [{ text: `Shortfall: ${doc.shortfallReason}`, margin: [0, 8, 0, 0] } as Content] : []),
          ...(doc.comments ? [{ text: `Comments: ${doc.comments}`, margin: [0, 6, 0, 0] } as Content] : []),
          {
            margin: [0, 30, 0, 0],
            table: {
              widths: ['*', '*'],
              heights: [70],
              body: [[signature('Sent by', doc.sentBy?.name, doc.sentAt), signature('Received by', doc.receivedBy?.name, doc.receivedAt)]],
            },
          },
        ],
        defaultStyle: { fontSize: 9 },
      };
      const buffer = await renderPdf(definition);
      await this.record(doc, AuditAction.PRINTED, viewer, new Date(), session);
      return { buffer, filename: `${doc.voucherNo}.pdf` };
    });
  }

  /** Out of the source for every line, dated as the transfer. */
  private sendEntries(doc: StockTransferDocument): StockEntryInput[] {
    return doc.lines.map((line) => ({
      productId: line.productId,
      locationId: doc.fromLocationId,
      qty: -line.qty,
      date: doc.date,
      voucherType: STOCK_TRANSFER_ENTITY_TYPE,
      voucherId: doc._id,
      voucherNo: doc.voucherNo,
    }));
  }

  /** Received quantity into the destination, shortfall back into the source. */
  private receiveEntries(doc: StockTransferDocument, at: Date): StockEntryInput[] {
    const base = { date: at, voucherType: STOCK_TRANSFER_ENTITY_TYPE, voucherId: doc._id, voucherNo: doc.voucherNo };
    return doc.lines.flatMap((line) => {
      const received = line.receivedQty ?? 0;
      return [
        { ...base, productId: line.productId, locationId: doc.toLocationId, qty: received },
        { ...base, productId: line.productId, locationId: doc.fromLocationId, qty: roundQty(line.qty - received) },
      ];
    });
  }

  /** Stored lines: one per product, both locations active stock-holding, products stock or bundle. */
  private async checkedLines(
    inputs: readonly StockTransferLineDto[],
    fromLocationId: string,
    toLocationId: string,
    session: ClientSession,
  ): Promise<StockTransferLine[]> {
    const seen = new Set<string>();
    for (const input of inputs) {
      if (seen.has(input.productId)) throw new BadRequestException(`Product ${input.productId} is on more than one line`);
      seen.add(input.productId);
      if (!(roundQty(input.qty) > 0)) throw new BadRequestException('Quantity must be greater than 0');
    }
    await this.stockService.assertHoldsStock([...seen], [fromLocationId, toLocationId], session);
    return inputs.map((input) => ({ productId: new Types.ObjectId(input.productId), qty: roundQty(input.qty), receivedQty: null }));
  }

  /** Field diff for the audit: date, locations, comments and each product's quantity. */
  private async diff(
    before: StockTransferDocument,
    after: { date: Date; fromLocationId: string; toLocationId: string; comments?: string; lines: readonly StockTransferLine[] },
    session: ClientSession,
  ): Promise<AuditChange[]> {
    const changes: AuditChange[] = [];
    const day = (date: Date) => date.toISOString().slice(0, 10);
    if (day(before.date) !== day(after.date)) {
      changes.push({ field: 'date', label: 'Date', from: day(before.date), to: day(after.date) });
    }
    const names = await this.locationNames(
      [before.fromLocationId, before.toLocationId, new Types.ObjectId(after.fromLocationId), new Types.ObjectId(after.toLocationId)],
      session,
    );
    for (const [field, label, was, now] of [
      ['fromLocationId', 'From', before.fromLocationId.toString(), after.fromLocationId],
      ['toLocationId', 'To', before.toLocationId.toString(), after.toLocationId],
    ] as const) {
      if (was !== now) changes.push({ field, label, from: names.get(was) ?? was, to: names.get(now) ?? now });
    }
    if ((before.comments ?? '') !== (after.comments ?? '')) {
      changes.push({ field: 'comments', label: 'Comments', from: before.comments ?? null, to: after.comments ?? null });
    }
    const describe = (lines: readonly StockTransferLine[]) => new Map(lines.map((line) => [line.productId.toString(), `${line.qty}`]));
    const from = describe(before.lines);
    const to = describe(after.lines);
    const productIds = [...new Set([...from.keys(), ...to.keys()])].filter((id) => from.get(id) !== to.get(id));
    const products = await this.productNames(
      productIds.map((id) => new Types.ObjectId(id)),
      session,
    );
    for (const productId of productIds) {
      changes.push({ field: 'lines', label: products.get(productId) ?? productId, from: from.get(productId) ?? null, to: to.get(productId) ?? null });
    }
    return changes;
  }

  private async productNames(ids: Types.ObjectId[], session: ClientSession): Promise<Map<string, string>> {
    const products = await this.productModel
      .find({ _id: { $in: ids } })
      .select('name')
      .session(session)
      .lean()
      .exec();
    return new Map(products.map((product) => [product._id.toString(), product.name]));
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
    if (!doc) throw new NotFoundException(`${LABEL} ${id} not found`);
    return doc;
  }

  private record(
    doc: StockTransferDocument,
    action: AuditAction,
    actor: Viewer,
    at: Date,
    session: ClientSession,
    extra: { changes?: AuditChange[]; reason?: string } = {},
  ) {
    return this.auditService.record(
      { entityType: STOCK_TRANSFER_ENTITY_TYPE, entityId: doc._id, entityRef: doc.voucherNo, action, actor, at, ...extra },
      session,
    );
  }
}

/** "own"-scoped users: only transfers touching their allowed locations. */
function scopeOf(user: Viewer | undefined): Record<string, unknown> | null {
  const allowed = stockLocationScope(user);
  if (!allowed) return null;
  const ids = allowed.map((id) => new Types.ObjectId(id));
  return { $or: [{ fromLocationId: { $in: ids } }, { toLocationId: { $in: ids } }] };
}

/** Single rule for the to-receive badge and the receivableByMe list filter. */
function receivableByFilter(viewer: Viewer): Record<string, unknown> {
  const allowed = stockLocationScope(viewer);
  return {
    status: PendingReceiptStatus.IN_TRANSIT,
    ...(allowed
      ? {
          toLocationId: { $in: allowed.map((id) => new Types.ObjectId(id)) },
          'sentBy.id': { $ne: new Types.ObjectId(viewer.id) },
        }
      : {}),
  };
}

function assertFromAllowed(user: Viewer, locationId: string): void {
  const allowed = stockLocationScope(user);
  if (allowed && !allowed.includes(locationId)) {
    throw new ForbiddenException('You may not send stock from this location');
  }
}

function assertDifferent(fromLocationId: string, toLocationId: string): void {
  if (fromLocationId === toLocationId) throw new BadRequestException('From and to must be different locations');
}

function totalQtyOf(lines: readonly { qty: number }[]): number {
  return roundQty(lines.reduce((sum, line) => sum + line.qty, 0));
}

/** Today is taken in Asia/Dubai (UTC+4, no DST). */
function assertNotFuture(date: string): void {
  const today = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (date.slice(0, 10) > today) throw new BadRequestException('The transfer date cannot be in the future');
}

function assertInTransit(doc: StockTransferDocument, action: string): void {
  if (doc.status !== PendingReceiptStatus.IN_TRANSIT) {
    throw new BadRequestException(`${LABEL} ${doc.voucherNo} is ${doc.status.replace('_', ' ')} and cannot be ${action}`);
  }
}

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`${LABEL} id "${id}" is not a valid id`);
}

/** A date-only filter bound covers the whole day. */
function endOfDayIfDateOnly(value: string): Date {
  const date = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCHours(23, 59, 59, 999);
  return date;
}
