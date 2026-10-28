import type { Column, Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { amountInWords } from '../../../common/utils/amount-in-words.js';

/** Labels that differ between voucher types (see VoucherDefinition.pdf and headerLabel). */
export interface VoucherPdfLabels {
  titles: { cash: string; bank: string; cheque?: string };
  documentTitle: string;
  /** Info-table label for the header account, e.g. "Received Into". */
  headerLabel: string;
  counterpartyColumn: string;
  signatures: readonly [string, string];
  /** Info-table label for the voucher's collector, e.g. "Collected By" / "Paid By". */
  collectorLabel: string;
}

/** Everything printed on the voucher, already resolved to display values. */
export interface VoucherPdfData {
  company: {
    legalName: string;
    addressLines: string[];
    phone: string | null;
    trn: string | null;
    footerText: string | null;
    /** Plain slips only: printed on top when set (Company.referenceReceiptHeaderText). */
    plainHeaderText?: string | null;
    currencyCode: string;
    /** PNG/JPEG as a data URL; pdfmake is never given a URL or path to fetch. */
    logoDataUrl: string | null;
  };
  voucher: {
    voucherNo: string;
    voucherDate: Date;
    /** The header (cash/wallet/bank) account. */
    headerAccountName: string;
    paymentMethod: 'cash' | 'cheque' | 'bank';
    paymentReference: string | null;
    collectedByName: string | null;
    /** Extra info-table rows. */
    extraInfo?: { label: string; value: string }[];
    lines: { counterparty: string; narration: string | null; amount: number; vat: number; netAmount: number }[];
    grossTotal: number;
    totalTax: number;
    grandTotal: number;
    comments: string | null;
    /** null on receipts from before audit tracking. */
    preparedBy: { name: string; at: Date | null } | null;
    cancelled: { reason: string | null; by: string | null; at: Date | null } | null;
  };
  /** 1 for the first print (ORIGINAL), then 2, 3, ... (DUPLICATEs). */
  copyNumber: number;
  printedBy: string;
  printedAt: Date;
}

export const PDF_TIME_ZONE = 'Asia/Dubai';

/** "ORIGINAL" for the first print, then "DUPLICATE - Reprint 1", "DUPLICATE - Reprint 2", ... */
export function copyLabel(copyNumber: number): string {
  return copyNumber <= 1 ? 'ORIGINAL' : `DUPLICATE - Reprint ${copyNumber - 1}`;
}

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function formatMoney(value: number): string {
  return money.format(value);
}

/** Voucher dates are calendar days stored at UTC midnight: format them in UTC so they never shift. */
export function formatVoucherDate(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(value);
}

/** A moment in UAE time, e.g. "16 Oct 2026, 14:05 GST". */
export function formatDubaiTime(value: Date): string {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: PDF_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value);
  return `${formatted} GST`;
}

const GREY = '#666666';
const BORDER = '#999999';

/**
 * Plain slip (reference receipts): no logo, company name, address or TRN.
 * Number, date, received from, amount and words, method, collected by, a
 * comment line and signature boxes; the ORIGINAL/DUPLICATE marker stays.
 */
export function buildPlainReceiptPdf(data: VoucherPdfData, labels: VoucherPdfLabels): TDocumentDefinitions {
  const { company, voucher: receipt } = data;
  const cheque = receipt.extraInfo?.filter((row) => row.label !== 'Cheque Status') ?? [];
  const row = (label: string, value: string) => [{ text: label, style: 'label' }, { text: value, colSpan: 3 }, '', ''];
  const signatureBox = (label: string): Column => ({
    width: '*',
    stack: [
      { canvas: [{ type: 'rect', x: 0, y: 0, w: 220, h: 55, lineColor: BORDER }] },
      { text: label, style: 'small', margin: [0, 4, 0, 0] },
    ],
  });

  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 60],
    info: { title: `${labels.documentTitle} ${receipt.voucherNo}` },
    ...(receipt.cancelled
      ? { watermark: { text: 'CANCELLED', color: '#b00020', opacity: 0.15, bold: true, angle: -45, fontSize: 90 } }
      : {}),
    content: [
      {
        columns: [
          { text: company.plainHeaderText ?? '', width: '*' },
          {
            width: 'auto',
            table: { body: [[{ text: copyLabel(data.copyNumber), style: 'copyLabel' }]] },
            layout: { hLineColor: BORDER, vLineColor: BORDER },
          },
        ],
      },
      { text: labels.titles[receipt.paymentMethod] ?? labels.titles.cash, style: 'title' },
      {
        table: {
          widths: [90, '*', 90, '*'],
          body: [
            [
              { text: 'Receipt No', style: 'label' },
              { text: receipt.voucherNo, bold: true },
              { text: 'Date', style: 'label' },
              formatVoucherDate(receipt.voucherDate),
            ],
            row('Received From', receipt.lines.map((line) => line.counterparty).join(', ')),
            row('Amount', `${company.currencyCode} ${formatMoney(receipt.grandTotal)}`),
            row('Amount in words', amountInWords(receipt.grandTotal)),
            row('Method', receipt.paymentMethod.toUpperCase()),
            ...cheque.map((info) => row(info.label, info.value)),
            row(labels.collectorLabel, receipt.collectedByName ?? '-'),
            row('Comment', receipt.comments ?? ''),
          ],
        },
        layout: { hLineColor: BORDER, vLineColor: BORDER },
        margin: [0, 0, 0, 12],
      },
      ...(receipt.cancelled
        ? [{ text: `CANCELLED: ${receipt.cancelled.reason ?? '-'}`, bold: true, color: '#b00020' } as Content]
        : []),
      {
        columns: [signatureBox(labels.signatures[0]), signatureBox(labels.signatures[1])],
        columnGap: 20,
        margin: [0, 30, 0, 0],
      },
    ],
    footer: (currentPage, pageCount) => ({
      margin: [40, 10, 40, 0],
      columns: [
        { text: `Printed by ${data.printedBy} on ${formatDubaiTime(data.printedAt)}`, style: 'small' },
        { text: `Page ${currentPage} of ${pageCount}`, style: 'small', alignment: 'right', width: 'auto' },
      ],
    }),
    styles: {
      title: { fontSize: 16, bold: true, alignment: 'center', margin: [0, 16, 0, 12] },
      copyLabel: { fontSize: 10, bold: true, margin: [6, 3, 6, 3] },
      label: { color: GREY },
      small: { fontSize: 8, color: GREY },
    },
    defaultStyle: { fontSize: 10 },
  };
}

/** A4 voucher layout. Pure: the same data always gives the same definition. */
export function buildVoucherPdf(data: VoucherPdfData, labels: VoucherPdfLabels): TDocumentDefinitions {
  const { company, voucher: receipt } = data;
  const isCancelled = receipt.cancelled !== null;

  const companyBlock: Content[] = [
    { text: company.legalName, style: 'companyName' },
    ...company.addressLines.map((line): Content => ({ text: line, style: 'companyLine' })),
    ...(company.phone ? [{ text: `Tel: ${company.phone}`, style: 'companyLine' } as Content] : []),
    ...(company.trn ? [{ text: `TRN: ${company.trn}`, style: 'companyLine' } as Content] : []),
  ];

  const header: Content = {
    columns: [
      ...(company.logoDataUrl ? [{ image: company.logoDataUrl, fit: [80, 60], width: 90 } as Content] : []),
      { stack: companyBlock, width: '*' },
      {
        width: 'auto',
        table: { body: [[{ text: copyLabel(data.copyNumber), style: 'copyLabel' }]] },
        layout: { hLineColor: BORDER, vLineColor: BORDER },
      },
    ],
    columnGap: 10,
  };

  const info: Content = {
    table: {
      widths: [90, '*', 90, '*'],
      body: [
        [
          { text: 'Voucher No', style: 'label' },
          { text: receipt.voucherNo, bold: true },
          { text: 'Date', style: 'label' },
          formatVoucherDate(receipt.voucherDate),
        ],
        [
          { text: labels.headerLabel, style: 'label' },
          receipt.headerAccountName,
          { text: labels.collectorLabel, style: 'label' },
          receipt.collectedByName ?? '-',
        ],
        ...(receipt.extraInfo ?? []).map((row) => [
          { text: row.label, style: 'label' },
          { text: row.value, colSpan: 3 },
          '',
          '',
        ]),
        ...(receipt.paymentReference
          ? [[{ text: 'Reference', style: 'label' }, { text: receipt.paymentReference, colSpan: 3 }, '', '']]
          : []),
      ],
    },
    layout: { hLineColor: BORDER, vLineColor: BORDER },
    margin: [0, 0, 0, 12],
  };

  const right = (text: string, extra: Record<string, unknown> = {}): Content => ({
    text,
    alignment: 'right',
    ...extra,
  });
  const lines: Content = {
    table: {
      headerRows: 1,
      widths: [18, '*', '*', 65, 55, 70],
      body: [
        ['#', labels.counterpartyColumn, 'Narration', 'Amount', 'VAT', 'Net'].map((text, i) => ({
          text,
          style: 'tableHeader',
          alignment: i >= 3 ? 'right' : 'left',
        })),
        ...receipt.lines.map((line, index) => [
          String(index + 1),
          line.counterparty,
          line.narration ?? '',
          right(formatMoney(line.amount)),
          right(formatMoney(line.vat)),
          right(formatMoney(line.netAmount)),
        ]),
      ],
    },
    layout: { hLineColor: BORDER, vLineColor: BORDER, fillColor: (row: number) => (row === 0 ? '#eeeeee' : null) },
  };

  const totals: Content = {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        table: {
          widths: [100, 90],
          body: [
            ['Gross Total', right(formatMoney(receipt.grossTotal))],
            ['Total Tax', right(formatMoney(receipt.totalTax))],
            [
              { text: `Grand Total (${company.currencyCode})`, bold: true },
              right(formatMoney(receipt.grandTotal), { bold: true }),
            ],
          ],
        },
        layout: 'noBorders',
      },
    ],
    margin: [0, 6, 0, 6],
  };

  const preparedBy = receipt.preparedBy
    ? `${receipt.preparedBy.name}${receipt.preparedBy.at ? ` on ${formatDubaiTime(receipt.preparedBy.at)}` : ''}`
    : 'Unknown';

  const cancellation: Content[] = receipt.cancelled
    ? [
        {
          table: {
            widths: ['*'],
            body: [
              [
                {
                  stack: [
                    { text: 'THIS VOUCHER IS CANCELLED', bold: true, color: '#b00020' },
                    `Cancelled by ${receipt.cancelled.by ?? 'Unknown'}${
                      receipt.cancelled.at ? ` on ${formatDubaiTime(receipt.cancelled.at)}` : ''
                    }`,
                    `Reason: ${receipt.cancelled.reason ?? '-'}`,
                  ],
                },
              ],
            ],
          },
          layout: { hLineColor: '#b00020', vLineColor: '#b00020' },
          margin: [0, 8, 0, 0],
        },
      ]
    : [];

  const signatureBox = (label: string): Column => ({
    width: '*',
    stack: [
      { canvas: [{ type: 'rect', x: 0, y: 0, w: 220, h: 55, lineColor: BORDER }] },
      { text: label, style: 'small', margin: [0, 4, 0, 0] },
    ],
  });

  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 60],
    info: { title: `${labels.documentTitle} ${receipt.voucherNo}`, author: company.legalName },
    ...(isCancelled
      ? { watermark: { text: 'CANCELLED', color: '#b00020', opacity: 0.15, bold: true, angle: -45, fontSize: 90 } }
      : {}),
    content: [
      header,
      { text: labels.titles[receipt.paymentMethod] ?? labels.titles.cash, style: 'title' },
      info,
      lines,
      totals,
      { text: [{ text: 'Amount in words: ', bold: true }, amountInWords(receipt.grandTotal)], margin: [0, 0, 0, 8] },
      ...(receipt.comments ? [{ text: [{ text: 'Comments: ', bold: true }, receipt.comments] } as Content] : []),
      { text: [{ text: 'Prepared by: ', bold: true }, preparedBy], margin: [0, 6, 0, 0] },
      ...cancellation,
      {
        columns: [signatureBox(labels.signatures[0]), signatureBox(labels.signatures[1])],
        columnGap: 20,
        margin: [0, 30, 0, 0],
      },
    ],
    footer: (currentPage, pageCount) => ({
      margin: [40, 10, 40, 0],
      stack: [
        ...(company.footerText ? [{ text: company.footerText, style: 'small', alignment: 'center' } as Content] : []),
        {
          columns: [
            { text: `Printed by ${data.printedBy} on ${formatDubaiTime(data.printedAt)}`, style: 'small' },
            { text: `Page ${currentPage} of ${pageCount}`, style: 'small', alignment: 'right', width: 'auto' },
          ],
        },
      ],
    }),
    styles: {
      companyName: { fontSize: 14, bold: true, margin: [0, 0, 0, 2] },
      companyLine: { fontSize: 9, color: '#444444', lineHeight: 1.15 },
      title: { fontSize: 16, bold: true, alignment: 'center', margin: [0, 16, 0, 12] },
      copyLabel: { fontSize: 10, bold: true, margin: [6, 3, 6, 3] },
      label: { color: GREY },
      tableHeader: { bold: true },
      small: { fontSize: 8, color: GREY },
    },
    defaultStyle: { fontSize: 10 },
  };
}
