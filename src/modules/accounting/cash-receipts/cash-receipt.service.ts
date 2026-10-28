import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { runInTransaction } from '../../../common/utils/transaction.util.js';
import { CashReceipt, CashReceiptDocument } from './schemas/cash-receipt.schema.js';
import { CreateCashReceiptDto } from './dto/create-cash-receipt.dto.js';
import { CancelCashReceiptDto, UpdateCashReceiptDto } from './dto/update-cash-receipt.dto.js';
import { CashReceiptQueryDto } from './dto/cash-receipt-query.dto.js';
import { CASH_RECEIPT_DEFINITION, REFERENCE_RECEIPT_DEFINITION } from './cash-receipt.definition.js';
import {
  VoucherPostingService,
  type VoucherListRow,
  type VoucherModel,
  type VoucherPage,
} from '../vouchers/voucher-posting.service.js';
import { CompanyService } from '../../company/company.service.js';
import { FilesService } from '../../files/files.service.js';
import { FileOwnerType } from '../../files/schemas/file-attachment.schema.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction, type AuditChange } from '../../audit/schemas/audit-log.schema.js';
import { CASH_RECEIPT_ENTITY_TYPE, ReceiptKind } from './schemas/cash-receipt.schema.js';
import { VoucherStatus } from '../vouchers/schemas/voucher.schema.js';
import { PaymentMethod } from '../vouchers/schemas/voucher.schema.js';
import type { Actor } from '../../../common/schemas/user-snapshot.schema.js';
import type { ScopedUser } from '../vouchers/data-scope.js';
import type { VoucherUpdateInput } from '../vouchers/voucher-posting.service.js';
import { AllocationService, type LineAllocation } from '../allocations/allocation.service.js';
import { PartyKind } from '../../party/schemas/party.schema.js';
import type { CashReceiptLineDto } from './dto/create-cash-receipt.dto.js';

/** The authenticated user; "own"-scoped users see and post only their own receipts. */
type Viewer = Actor & ScopedUser;

export { CASH_RECEIPT_VOUCHER_SEQUENCE, RECEIPT_LINE_ACCOUNT_TYPES } from './cash-receipt.definition.js';

export type CashReceiptListRow = Omit<VoucherListRow, 'header'> & { cashAccount: VoucherListRow['header'] };
export type CashReceiptPage = VoucherPage<CashReceiptListRow>;

/**
 * Cash/bank receipts. Every posting rule lives in VoucherPostingService;
 * this only maps the receipt's own field names (cashAccountId) onto it.
 */
@Injectable()
export class CashReceiptService {
  private readonly model: VoucherModel;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(CashReceipt.name) private readonly cashReceiptModel: Model<CashReceiptDocument>,
    private readonly posting: VoucherPostingService,
    private readonly companyService: CompanyService,
    private readonly filesService: FilesService,
    private readonly auditService: AuditService,
    private readonly allocations: AllocationService,
  ) {
    this.model = cashReceiptModel as unknown as VoucherModel;
    posting.registerVoucherType(CASH_RECEIPT_DEFINITION, this.model);
    allocations.registerPaymentSource(CASH_RECEIPT_ENTITY_TYPE, this.model, PartyKind.CUSTOMER);
  }

  /** Receipts without a receiptKind (before it existed) are standard. */
  async findAll(query: CashReceiptQueryDto = {}, viewer?: Viewer): Promise<CashReceiptPage> {
    const { cashAccountId, kind = ReceiptKind.STANDARD, ...rest } = query;
    const kindFilter =
      kind === 'all' ? null : { receiptKind: kind === ReceiptKind.REFERENCE ? kind : { $ne: ReceiptKind.REFERENCE } };
    const page = await this.posting.list(
      CASH_RECEIPT_DEFINITION,
      this.model,
      { ...rest, headerAccountId: cashAccountId },
      viewer,
      kindFilter,
    );
    return { ...page, items: page.items.map(({ header, ...row }) => ({ ...row, cashAccount: header })) };
  }

  async findById(id: string, viewer?: Viewer): Promise<CashReceiptDocument> {
    return (await this.posting.findById(
      CASH_RECEIPT_DEFINITION,
      this.model,
      id,
      viewer,
    )) as unknown as CashReceiptDocument;
  }

  /**
   * `actor` is the authenticated user; nothing in the DTO can set who created
   * the receipt. With `session` it joins the caller's transaction (pay-at-sale).
   */
  async create(dto: CreateCashReceiptDto, actor: Viewer, session?: ClientSession): Promise<CashReceiptDocument> {
    const { cashAccountId, lines, receiptKind = ReceiptKind.STANDARD, ...rest } = dto;
    if (receiptKind === ReceiptKind.REFERENCE) assertNoVat(lines);
    const requests = allocationsOf(lines);
    return (await this.posting.create(
      definitionOf(receiptKind),
      this.model,
      {
        ...rest,
        headerAccountId: cashAccountId ?? (await this.chequesInHandFor(dto.paymentMethod)),
        extraFields: { receiptKind },
        lines: lines.map(withoutAllocations),
        afterPost: (voucher, txn) =>
          this.allocations.allocateForPayment(CASH_RECEIPT_ENTITY_TYPE, voucher, requests, actor, txn),
      },
      actor,
      session,
    )) as unknown as CashReceiptDocument;
  }

  /** Sending lines reverses the receipt's allocations and reposts the ones on those lines. */
  async update(id: string, dto: UpdateCashReceiptDto, actor: Viewer): Promise<CashReceiptDocument> {
    const { cashAccountId, lines, ...rest } = dto;
    // Switching to cheque without naming an account: the company's cheques in hand.
    const current = await this.findById(id, actor);
    const def = definitionOf(current.receiptKind);
    const headerAccountId =
      !cashAccountId && dto.paymentMethod === PaymentMethod.CHEQUE && current.paymentMethod !== PaymentMethod.CHEQUE
        ? await this.chequesInHandFor(dto.paymentMethod)
        : cashAccountId;
    const input: VoucherUpdateInput = { ...rest, headerAccountId };
    if (lines) {
      if (current.receiptKind === ReceiptKind.REFERENCE) assertNoVat(lines);
      const requests = allocationsOf(lines);
      input.lines = lines.map(withoutAllocations);
      const [from, to] = await Promise.all([
        this.allocations.describePayment(CASH_RECEIPT_ENTITY_TYPE, id),
        this.allocations.describeRequests(requests),
      ]);
      if (from !== to) {
        input.extraChanges = [{ field: 'allocations', label: 'Allocations', from: from || null, to: to || null }];
      }
      input.afterPost = async (voucher, session) => {
        await this.allocations.reverseForPayment(CASH_RECEIPT_ENTITY_TYPE, voucher._id, 'Receipt edited', actor, session);
        await this.allocations.allocateForPayment(CASH_RECEIPT_ENTITY_TYPE, voucher, requests, actor, session);
      };
    }
    return (await this.posting.update(def, this.model, id, input, actor)) as unknown as CashReceiptDocument;
  }

  /** Reverses the posting and its allocations and keeps the receipt, marked cancelled, with who/when/why. */
  async cancel(id: string, dto: CancelCashReceiptDto, actor: Viewer, session?: ClientSession): Promise<CashReceiptDocument> {
    return (await this.posting.cancel(
      definitionOf((await this.findById(id, actor)).receiptKind),
      this.model,
      id,
      dto?.reason,
      actor,
      (voucher, reason, txn) =>
        this.allocations.reverseForPayment(CASH_RECEIPT_ENTITY_TYPE, voucher._id, `Receipt cancelled: ${reason}`, actor, txn),
      session,
    )) as unknown as CashReceiptDocument;
  }

  /**
   * Stores the file through /files and attaches it (cheque photo, transfer
   * slip). Anyone who can see the receipt may attach to it while it is not
   * cancelled; if attaching fails the stored file is removed again.
   */
  async addAttachment(id: string, file: Express.Multer.File | undefined, actor: Viewer): Promise<CashReceiptDocument> {
    const receipt = await this.findById(id, actor);
    if (receipt.status === VoucherStatus.CANCELLED) {
      throw new BadRequestException(`${receipt.voucherNo} is cancelled`);
    }
    const stored = await this.filesService.upload(file, { ownerType: FileOwnerType.CASH_RECEIPT, ownerId: id }, actor.id);
    try {
      return await runInTransaction(this.connection, async (session) => {
        const current = (await this.cashReceiptModel.findById(receipt._id).session(session).exec())!;
        current.attachments.push({
          fileRef: new Types.ObjectId(stored.id),
          title: stored.originalName,
          mimeType: stored.mimeType,
          uploadedAt: new Date(),
        } as never);
        await current.save({ session });
        await this.recordAttachment(
          current,
          { field: 'attachments', label: 'Attachment added', from: null, to: stored.originalName },
          actor,
          session,
        );
        return current;
      });
    } catch (error) {
      await this.filesService.remove(stored.id).catch(() => undefined);
      throw error;
    }
  }

  /** Detaches the file, then deletes it from storage. */
  async removeAttachment(id: string, attachmentId: string, actor: Viewer): Promise<CashReceiptDocument> {
    const receipt = await this.findById(id, actor);
    const attachment = Types.ObjectId.isValid(attachmentId)
      ? receipt.attachments.find((entry) => entry._id.equals(attachmentId))
      : undefined;
    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found on ${receipt.voucherNo}`);
    }
    const saved = await runInTransaction(this.connection, async (session) => {
      const current = (await this.cashReceiptModel.findById(receipt._id).session(session).exec())!;
      current.set(
        'attachments',
        current.attachments.filter((entry) => !entry._id.equals(attachment._id)),
      );
      await current.save({ session });
      await this.recordAttachment(
        current,
        { field: 'attachments', label: 'Attachment removed', from: attachment.title, to: null },
        actor,
        session,
      );
      return current;
    });
    // After the commit: nothing points at the file any more.
    await this.filesService.remove(attachment.fileRef.toString()).catch(() => undefined);
    return saved;
  }

  private recordAttachment(receipt: CashReceiptDocument, change: AuditChange, actor: Viewer, session: ClientSession) {
    return this.auditService.record(
      {
        entityType: CASH_RECEIPT_ENTITY_TYPE,
        entityId: receipt._id,
        entityRef: receipt.voucherNo,
        action: AuditAction.UPDATED,
        actor,
        changes: [change],
      },
      session,
    );
  }

  /**
   * A cheque is a document, not an account the user picks: unless one is
   * named it goes into the company's default cheques in hand account and
   * stays pending there until it is cleared.
   */
  private async chequesInHandFor(method: PaymentMethod | undefined): Promise<string> {
    const id = method === PaymentMethod.CHEQUE ? (await this.companyService.ensure()).defaultChequesInHandAccountId : null;
    if (!id) {
      throw new BadRequestException(
        method === PaymentMethod.CHEQUE
          ? "Set the company's default cheques in hand account (Company Profile) before receiving cheques"
          : 'cashAccountId is required',
      );
    }
    return id.toString();
  }

  async remove(id: string, viewer?: Viewer): Promise<{ success: true }> {
    return this.posting.remove(definitionOf((await this.findById(id, viewer)).receiptKind), this.model, id, viewer);
  }
}

function definitionOf(kind: ReceiptKind | undefined) {
  return kind === ReceiptKind.REFERENCE ? REFERENCE_RECEIPT_DEFINITION : CASH_RECEIPT_DEFINITION;
}

function assertNoVat(lines: readonly CashReceiptLineDto[]): void {
  if (lines.some((line) => line.vat)) {
    throw new BadRequestException('A reference receipt has no VAT: every line must have VAT 0');
  }
}

function allocationsOf(lines: readonly CashReceiptLineDto[]): LineAllocation[] {
  return lines.flatMap((line, lineIndex) => (line.allocations ?? []).map((allocation) => ({ lineIndex, ...allocation })));
}

function withoutAllocations({ allocations: _allocations, ...line }: CashReceiptLineDto) {
  return line;
}
