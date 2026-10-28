import { BadRequestException, Injectable, StreamableFile } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { LedgerEntry, LedgerEntryDocument } from '../accounting/vouchers/schemas/ledger-entry.schema.js';
import { formatDubaiTime, formatMoney } from '../accounting/vouchers/voucher-pdf.js';
import { CompanyService } from '../company/company.service.js';
import { renderPdf } from '../../common/pdf/pdf-renderer.js';
import { round2 } from '../../common/utils/money.util.js';

export interface DateRange {
  from: Date | null;
  to: Date | null;
}

export interface ExportColumn {
  key: string;
  label: string;
  /** Money columns are right-aligned and shown with 2 decimals. */
  money?: boolean;
}

type Cell = string | number | null | undefined;

export interface ExportTable {
  title: string;
  subtitle: string;
  columns: ExportColumn[];
  rows: object[];
}

export function pageOf(query: { page?: number; limit?: number }): { skip: number; limit: number; page: number } {
  const page = query.page ?? 1;
  const limit = query.limit ?? 100;
  return { skip: (page - 1) * limit, limit, page };
}

/** Helpers shared by the accounting reports: date bounds, opening balance, cancelled vouchers, CSV/PDF export. */
@Injectable()
export class ReportService {
  constructor(
    @InjectModel(LedgerEntry.name) private readonly entryModel: Model<LedgerEntryDocument>,
    private readonly companyService: CompanyService,
  ) {}

  /**
   * Voucher dates are calendar days stored at UTC midnight, which is how a Dubai
   * day is keyed too, so a date-only value covers that whole day; a full
   * timestamp is used as given.
   */
  rangeOf(query: { dateFrom?: string; dateTo?: string }): DateRange {
    const from = query.dateFrom ? new Date(query.dateFrom) : null;
    const to = query.dateTo ? this.endOfDay(query.dateTo) : null;
    if (from && to && from > to) {
      throw new BadRequestException('dateFrom must not be after dateTo');
    }
    return { from, to };
  }

  endOfDay(value: string): Date {
    const date = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCHours(23, 59, 59, 999);
    return date;
  }

  dateFilter({ from, to }: DateRange): Record<string, unknown> {
    if (!from && !to) return {};
    return { voucherDate: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } };
  }

  /** Sum of debit - credit of the match's entries dated before `from` (0 without a start date). */
  async openingBalance(match: Record<string, unknown>, from: Date | null): Promise<number> {
    if (!from) return 0;
    const [row] = await this.entryModel
      .aggregate<{ net: number }>([
        { $match: { ...match, voucherDate: { $lt: from } } },
        { $group: { _id: null, net: { $sum: { $subtract: ['$debit', '$credit'] } } } },
      ])
      .exec();
    return round2(row?.net ?? 0);
  }

  /** Vouchers cancelled in the range; their entries and reversals net to zero, so reports leave them out. */
  async cancelledVoucherIds(range: DateRange, match: Record<string, unknown> = {}) {
    return this.entryModel
      .distinct('voucherId', { ...match, ...this.dateFilter(range), cause: 'cancelled' })
      .exec();
  }

  /** Same window the ledger uses: entries in posting order with a running net. */
  static readonly ORDER = { voucherDate: 1, postedAt: 1, _id: 1 } as const;

  /** A downloadable CSV or A4 PDF of the same rows the screen shows. */
  async export(table: ExportTable, format: 'csv' | 'pdf'): Promise<StreamableFile> {
    const filename = `${table.title.toLowerCase().replace(/\s+/g, '-')}.${format}`;
    if (format === 'csv') {
      const cell = (value: Cell) => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const lines = [
        table.columns.map((column) => cell(column.label)).join(','),
        ...table.rows.map((row) =>
          table.columns
            .map((column) => {
              const value = (row as Record<string, Cell>)[column.key];
              return cell(column.money && typeof value === 'number' ? value.toFixed(2) : value);
            })
            .join(','),
        ),
      ];
      return new StreamableFile(Buffer.from(lines.join('\r\n'), 'utf8'), {
        type: 'text/csv; charset=utf-8',
        disposition: `attachment; filename="${filename}"`,
      });
    }
    const buffer = await renderPdf(await this.pdfDefinition(table));
    return new StreamableFile(buffer, { type: 'application/pdf', disposition: `attachment; filename="${filename}"` });
  }

  private async pdfDefinition(table: ExportTable): Promise<TDocumentDefinitions> {
    const { settings } = await this.companyService.getForPrinting();
    const address = [settings.addressLine1, settings.addressLine2, [settings.city, settings.country].filter(Boolean).join(', ')]
      .filter(Boolean)
      .join(', ');
    const header: Content[] = [
      { text: settings.legalName, fontSize: 13, bold: true },
      ...(address ? [{ text: address, fontSize: 8, color: '#666666' } as Content] : []),
      ...(settings.trn ? [{ text: `TRN: ${settings.trn}`, fontSize: 8, color: '#666666' } as Content] : []),
      { text: table.title, fontSize: 12, bold: true, margin: [0, 10, 0, 0] },
      { text: table.subtitle, fontSize: 8, color: '#666666', margin: [0, 0, 0, 8] },
    ];
    const head: TableCell[] = table.columns.map((column) => ({
      text: column.label,
      bold: true,
      fillColor: '#eeeeee',
      alignment: column.money ? 'right' : 'left',
    }));
    const body: TableCell[][] = table.rows.map((row) =>
      table.columns.map((column): TableCell => {
        const value = (row as Record<string, Cell>)[column.key];
        return column.money
          ? { text: typeof value === 'number' ? formatMoney(value) : '', alignment: 'right' }
          : { text: value === null || value === undefined ? '' : String(value) };
      }),
    );
    return {
      pageSize: 'A4',
      pageMargins: [28, 28, 28, 36],
      defaultStyle: { fontSize: 8 },
      content: [
        ...header,
        { table: { headerRows: 1, widths: table.columns.map((column) => (column.money ? 'auto' : '*')), body: [head, ...body] }, layout: 'lightHorizontalLines' },
      ],
      footer: (current: number, count: number) => ({
        text: `Printed ${formatDubaiTime(new Date())}  -  Page ${current} of ${count}`,
        alignment: 'center',
        fontSize: 7,
        color: '#666666',
      }),
    };
  }
}
