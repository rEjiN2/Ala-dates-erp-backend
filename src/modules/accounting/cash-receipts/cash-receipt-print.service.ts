import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';
import {
  CASH_RECEIPT_ENTITY_TYPE,
  CashReceipt,
  CashReceiptDocument,
  CashReceiptStatus,
} from './schemas/cash-receipt.schema.js';
import { buildCashReceiptPdf, copyLabel } from './cash-receipt-pdf.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { CompanyService } from '../../company/company.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction } from '../../audit/schemas/audit-log.schema.js';
import type { Actor } from '../../../common/schemas/user-snapshot.schema.js';
import { renderPdf } from '../../../common/pdf/pdf-renderer.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

export interface PrintedCashReceipt {
  buffer: Buffer;
  filename: string;
  copyNumber: number;
  /** The pdfmake definition the buffer was rendered from (kept for tests and debugging). */
  definition: TDocumentDefinitions;
}

@Injectable()
export class CashReceiptPrintService {
  constructor(
    @InjectModel(CashReceipt.name) private readonly cashReceiptModel: Model<CashReceiptDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly ledgerAccountService: LedgerAccountService,
    private readonly companyService: CompanyService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Renders the voucher and records the print. The copy number, the PDF and
   * the "printed" audit entry come from one transaction: the atomic
   * printCount increment means two simultaneous prints can't both be the
   * ORIGINAL, and a render that fails leaves neither a count nor an entry.
   */
  async print(id: string, actor: Actor): Promise<PrintedCashReceipt> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Cash receipt id "${id}" is not a valid id`);
    }
    // Fetched before the transaction: it may call out to file storage.
    const { settings, logoDataUrl } = await this.companyService.getForPrinting();

    return runInTransaction(this.connection, async (session) => {
      const receipt = await this.cashReceiptModel
        .findOneAndUpdate(
          { _id: new Types.ObjectId(id) },
          { $inc: { printCount: 1 } },
          { returnDocument: 'after', session },
        )
        .exec();
      if (!receipt) {
        throw new NotFoundException(`Cash receipt ${id} not found`);
      }

      const names = await this.ledgerAccountService.getNames(
        [receipt.cashAccountId.toString(), ...receipt.lines.map((line) => line.accountId.toString())],
        session,
      );
      const nameOf = (accountId: Types.ObjectId) => names.get(accountId.toString()) ?? accountId.toString();
      const printedAt = new Date();
      const copyNumber = receipt.printCount;

      const definition = buildCashReceiptPdf({
        company: {
          legalName: settings.legalName,
          addressLines: [
            settings.addressLine1,
            settings.addressLine2,
            [settings.city, settings.country].filter(Boolean).join(', '),
          ].filter((line): line is string => Boolean(line)),
          phone: settings.phone,
          trn: settings.trn,
          footerText: settings.receiptFooterText,
          currencyCode: settings.currencyCode,
          logoDataUrl,
        },
        receipt: {
          voucherNo: receipt.voucherNo,
          voucherDate: receipt.voucherDate,
          cashAccountName: nameOf(receipt.cashAccountId),
          cashierName: receipt.cashierName,
          paymentMethod: receipt.paymentMethod ?? 'cash',
          paymentReference: receipt.paymentReference ?? null,
          lines: receipt.lines.map((line) => ({
            receivedFrom: nameOf(line.accountId),
            narration: line.narration ?? null,
            amount: line.amount,
            vat: line.vat,
            netAmount: line.netAmount,
          })),
          grossTotal: receipt.grossTotal,
          totalTax: receipt.totalTax,
          grandTotal: receipt.grandTotal,
          comments: receipt.comments ?? null,
          preparedBy: receipt.createdBy ? { name: receipt.createdBy.name, at: receipt.createdAt } : null,
          cancelled:
            receipt.status === CashReceiptStatus.CANCELLED
              ? { reason: receipt.cancelReason, by: receipt.cancelledBy?.name ?? null, at: receipt.cancelledAt }
              : null,
        },
        copyNumber,
        printedBy: actor.name,
        printedAt,
      });
      const buffer = await renderPdf(definition);

      await this.auditService.record(
        {
          entityType: CASH_RECEIPT_ENTITY_TYPE,
          entityId: receipt._id,
          entityRef: receipt.voucherNo,
          action: AuditAction.PRINTED,
          actor,
          changes: [{ field: 'copy', label: 'Copy', from: null, to: copyLabel(copyNumber) }],
          at: printedAt,
        },
        session,
      );

      return { buffer, filename: `${receipt.voucherNo}.pdf`, copyNumber, definition };
    });
  }
}
