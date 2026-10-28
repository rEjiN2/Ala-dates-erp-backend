import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { VoucherStatus } from './schemas/voucher.schema.js';
import type { VoucherDefinition } from './voucher-definition.js';
import type { VoucherModel } from './voucher-posting.service.js';
import { buildPlainReceiptPdf, buildVoucherPdf, copyLabel } from './voucher-pdf.js';
import { withScope } from './data-scope.js';
import { LedgerAccountService } from '../ledger-accounts/ledger-account.service.js';
import { CompanyService } from '../../company/company.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction } from '../../audit/schemas/audit-log.schema.js';
import type { Actor } from '../../../common/schemas/user-snapshot.schema.js';
import { renderPdf } from '../../../common/pdf/pdf-renderer.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

export interface PrintedVoucher {
  buffer: Buffer;
  filename: string;
  copyNumber: number;
  /** The pdfmake definition the buffer was rendered from (kept for tests and debugging). */
  definition: TDocumentDefinitions;
}

@Injectable()
export class VoucherPrintService {
  constructor(
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
  /** `scope` (from VoucherPostingService.scopeFilter) limits which vouchers the actor may print; others are 404. */
  async print(
    def: VoucherDefinition,
    model: VoucherModel,
    id: string,
    actor: Actor,
    scope: Record<string, unknown> | null = null,
  ): Promise<PrintedVoucher> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`${def.label} id "${id}" is not a valid id`);
    }
    // Fetched before the transaction: it may call out to file storage.
    const { settings, logoDataUrl } = await this.companyService.getForPrinting();

    return runInTransaction(this.connection, async (session) => {
      const voucher = await model
        .findOneAndUpdate(
          withScope({ _id: new Types.ObjectId(id) }, scope),
          { $inc: { printCount: 1 } },
          { returnDocument: 'after', session },
        )
        .exec();
      if (!voucher) {
        throw new NotFoundException(`${def.label} ${id} not found`);
      }

      const headerAccountId = def.pdf.headerAccountName
        ? null
        : (voucher.get(def.headerField) as Types.ObjectId).toString();
      const names = await this.ledgerAccountService.getNames(
        [...(headerAccountId ? [headerAccountId] : []), ...voucher.lines.map((line) => line.accountId.toString())],
        session,
      );
      const nameOf = (accountId: string) => names.get(accountId) ?? accountId;
      const printedAt = new Date();
      const copyNumber = voucher.printCount;

      const definition = (def.pdf.plain ? buildPlainReceiptPdf : buildVoucherPdf)(
        {
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
            plainHeaderText: settings.referenceReceiptHeaderText,
            currencyCode: settings.currencyCode,
            logoDataUrl,
          },
          voucher: {
            voucherNo: voucher.voucherNo,
            voucherDate: voucher.voucherDate,
            headerAccountName: def.pdf.headerAccountName?.(voucher) ?? nameOf(headerAccountId!),
            collectedByName: voucher.collectedByName,
            extraInfo: def.pdf.extraInfo?.(voucher) ?? [],
            paymentMethod: voucher.paymentMethod ?? 'cash',
            paymentReference: voucher.paymentReference ?? null,
            ...(def.pdf.body?.(voucher) ?? {
              lines: voucher.lines.map((line) => ({
                counterparty: nameOf(line.accountId.toString()),
                narration: line.narration ?? null,
                amount: line.amount,
                vat: line.vat,
                netAmount: line.netAmount,
              })),
              grossTotal: voucher.grossTotal,
              totalTax: voucher.totalTax,
              grandTotal: voucher.grandTotal,
            }),
            comments: voucher.comments ?? null,
            preparedBy: voucher.createdBy ? { name: voucher.createdBy.name, at: voucher.createdAt } : null,
            cancelled:
              voucher.status === VoucherStatus.CANCELLED
                ? { reason: voucher.cancelReason, by: voucher.cancelledBy?.name ?? null, at: voucher.cancelledAt }
                : null,
          },
          copyNumber,
          printedBy: actor.name,
          printedAt,
        },
        {
          titles: def.pdf.titles,
          documentTitle: def.pdf.documentTitle,
          headerLabel: titleCase(def.headerLabel),
          counterpartyColumn: def.pdf.counterpartyColumn,
          signatures: def.pdf.signatures,
          collectorLabel: def.collectorLabel,
        },
      );
      const buffer = await renderPdf(definition);

      await this.auditService.record(
        {
          entityType: def.entityType,
          entityId: voucher._id,
          entityRef: voucher.voucherNo,
          action: AuditAction.PRINTED,
          actor,
          changes: [{ field: 'copy', label: 'Copy', from: null, to: copyLabel(copyNumber) }],
          at: printedAt,
        },
        session,
      );

      return { buffer, filename: `${voucher.voucherNo}.pdf`, copyNumber, definition };
    });
  }
}

/** "Received into" -> "Received Into", for the PDF's info table. */
function titleCase(label: string): string {
  return label.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
