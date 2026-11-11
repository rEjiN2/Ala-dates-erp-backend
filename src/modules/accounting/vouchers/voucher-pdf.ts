import type { Column, Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { amountInWords } from '../../../common/utils/amount-in-words.js';
import { round2 } from '../../../common/utils/money.util.js';
import { presetFor, type PrintPreset, type PrintSize } from '../../../common/pdf/print-layout.js';

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

/**
 * Item documents (invoices, credit/debit notes): Product, Qty, Unit price and
 * Total (qty x unit price) per line, discount in the totals, VAT by rate.
 */
export interface ItemDocument {
  lines: { product: string; qty: number; rate: number; discount: number; total: number }[];
  subtotal: number;
  discountTotal: number;
  /** Invoice-level discount (spread over the lines); shown as its own totals line. */
  invoiceDiscount: number;
  /** Any line has its own discount: the Discount column is printed. */
  hasLineDiscount: boolean;
  vatSummary: { rate: number; taxable: number; vat: number }[];
  /** Print the amount in words (invoices). */
  showWords: boolean;
}

export interface ItemSourceLine {
  product: string;
  qty: number;
  rate: number;
  discount: number;
  /** Share of the invoice discount; the line's taxable amount is already net of it. */
  allocatedDiscount?: number;
  vatRate: number;
  /** Taxable amount: qty x rate - discount - allocatedDiscount. */
  amount: number;
  vat: number;
}

export function itemDocument(lines: readonly ItemSourceLine[], showWords: boolean): ItemDocument {
  const vat = new Map<number, { taxable: number; vat: number }>();
  const rows = lines.map((line) => {
    const row = vat.get(line.vatRate) ?? { taxable: 0, vat: 0 };
    vat.set(line.vatRate, { taxable: round2(row.taxable + line.amount), vat: round2(row.vat + line.vat) });
    return {
      product: line.product,
      qty: line.qty,
      rate: line.rate,
      discount: line.discount,
      total: round2(line.amount + line.discount + (line.allocatedDiscount ?? 0)),
    };
  });
  return {
    lines: rows,
    subtotal: round2(rows.reduce((sum, row) => sum + row.total, 0)),
    discountTotal: round2(lines.reduce((sum, line) => sum + line.discount, 0)),
    invoiceDiscount: round2(lines.reduce((sum, line) => sum + (line.allocatedDiscount ?? 0), 0)),
    hasLineDiscount: lines.some((line) => line.discount > 0),
    vatSummary: [...vat].map(([rate, row]) => ({ rate, ...row })),
    showWords,
  };
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
    /** Set for item documents: replaces the narration columns (see ItemDocument). */
    items?: ItemDocument;
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
  /** Page size; a4 when omitted. */
  size?: PrintSize;
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

const right = (text: string, extra: Record<string, unknown> = {}): Content => ({
  text,
  alignment: 'right',
  ...extra,
});

/** Label left, value right, on one line (stacked layouts). */
const row2 = (left: string, value: string, extra: Record<string, unknown> = {}): Content => ({
  columns: [
    { text: left, width: '*', ...extra },
    { text: value, width: 'auto', alignment: 'right', ...extra },
  ],
});

const separator = (p: PrintPreset): Content => ({
  canvas: [{ type: 'line', x1: 0, y1: 0, x2: p.contentWidth, y2: 0, lineWidth: 0.5, lineColor: BORDER, dash: { length: 2 } }],
  margin: [0, 3, 0, 3],
});

function stylesFor(p: PrintPreset) {
  return {
    companyName: { fontSize: p.fontSize + 4, bold: true, margin: [0, 0, 0, 2] as [number, number, number, number] },
    companyLine: { fontSize: p.fontSize - 1, color: '#444444', lineHeight: 1.15 },
    title: {
      fontSize: p.titleSize,
      bold: true,
      alignment: 'center' as const,
      margin: (p.stacked ? [0, 6, 0, 4] : [0, 16, 0, 12]) as [number, number, number, number],
    },
    copyLabel: { fontSize: p.fontSize, bold: true, margin: [6, 3, 6, 3] as [number, number, number, number] },
    label: { color: GREY },
    tableHeader: { bold: true },
    small: { fontSize: Math.max(6, p.fontSize - 2), color: GREY },
  };
}

const copyBox = (data: VoucherPdfData) => ({
  width: 'auto' as const,
  table: { body: [[{ text: copyLabel(data.copyNumber), style: 'copyLabel' }]] },
  layout: { hLineColor: BORDER, vLineColor: BORDER },
});

interface InfoPair {
  label: string;
  value: string;
  bold?: boolean;
}

/** Two pairs per row on wide pages (the first `paired`), one per row on stacked ones. */
function infoTable(pairs: InfoPair[], paired: number, p: PrintPreset): Content {
  const label = (text: string): TableCell => ({ text, style: 'label' });
  const value = (pair: InfoPair) => ({ text: pair.value, bold: pair.bold });
  const body: TableCell[][] = [];
  if (p.stacked) {
    for (const pair of pairs) body.push([label(pair.label), value(pair)]);
  } else {
    for (let i = 0; i < paired; i += 2) {
      body.push([label(pairs[i].label), value(pairs[i]), label(pairs[i + 1].label), value(pairs[i + 1])]);
    }
    for (const pair of pairs.slice(paired)) {
      body.push([label(pair.label), { ...value(pair), colSpan: 3 }, '', '']);
    }
  }
  return {
    table: {
      widths: p.stacked ? [p.labelWidth, '*'] : [p.labelWidth, '*', p.labelWidth, '*'],
      body,
    },
    layout: { hLineColor: BORDER, vLineColor: BORDER },
    margin: [0, 0, 0, 12],
  };
}

function signatureRow(labels: readonly [string, string], p: PrintPreset): Content[] {
  if (p.thermal) return [];
  const box = (label: string): Column => ({
    width: '*',
    stack: [
      { canvas: [{ type: 'rect', x: 0, y: 0, w: p.signature.w, h: p.signature.h, lineColor: BORDER }] },
      { text: label, style: 'small', margin: [0, 4, 0, 0] },
    ],
  });
  return [{ columns: [box(labels[0]), box(labels[1])], columnGap: 20, margin: [0, p.stacked ? 8 : 30, 0, 0] }];
}

function footerFor(data: VoucherPdfData, p: PrintPreset, footerText: string | null) {
  return (currentPage: number, pageCount: number): Content => ({
    margin: [p.margins[0], 10, p.margins[2], 0],
    stack: [
      ...(footerText ? [{ text: footerText, style: 'small', alignment: 'center' } as Content] : []),
      p.thermal
        ? { text: `Printed by ${data.printedBy} on ${formatDubaiTime(data.printedAt)}`, style: 'small' }
        : {
            columns: [
              { text: `Printed by ${data.printedBy} on ${formatDubaiTime(data.printedAt)}`, style: 'small' },
              { text: `Page ${currentPage} of ${pageCount}`, style: 'small', alignment: 'right', width: 'auto' },
            ],
          },
    ],
  });
}

const watermarkFor = (p: PrintPreset) =>
  p.thermal ? {} : { watermark: { text: 'CANCELLED', color: '#b00020', opacity: 0.15, bold: true, angle: -45, fontSize: p.watermarkSize } };

/** Rows of [label, value, bold] as a right-hand totals block. */
function totalsBlock(rows: [string, string, boolean?][], p: PrintPreset): Content {
  const table: Column = {
    width: p.stacked ? '*' : 'auto',
    table: {
      widths: p.stacked ? ['*', 'auto'] : p.totalsCols,
      body: rows.map(([label, value, bold]) => [{ text: label, bold }, right(value, { bold })]),
    },
    layout: 'noBorders',
  };
  return { columns: [...(p.stacked ? [] : [{ width: '*', text: '' } as Content]), table], margin: [0, 6, 0, 6] };
}

/**
 * Plain slip (reference receipts): no logo, company name, address or TRN.
 * Number, date, received from, amount and words, method, collected by, a
 * comment line and signature boxes; the ORIGINAL/DUPLICATE marker stays.
 */
export function buildPlainReceiptPdf(data: VoucherPdfData, labels: VoucherPdfLabels): TDocumentDefinitions {
  const { company, voucher: receipt } = data;
  const p = presetFor(data.size);
  const cheque = receipt.extraInfo?.filter((row) => row.label !== 'Cheque Status') ?? [];

  return {
    pageSize: p.pageSize,
    pageMargins: p.margins,
    info: { title: `${labels.documentTitle} ${receipt.voucherNo}` },
    ...(receipt.cancelled ? watermarkFor(p) : {}),
    content: [
      p.stacked
        ? { stack: [{ text: company.plainHeaderText ?? '' }, { ...copyBox(data), margin: [0, 4, 0, 0] }] }
        : { columns: [{ text: company.plainHeaderText ?? '', width: '*' }, copyBox(data)] },
      { text: labels.titles[receipt.paymentMethod] ?? labels.titles.cash, style: 'title' },
      infoTable(
        [
          { label: 'Receipt No', value: receipt.voucherNo, bold: true },
          { label: 'Date', value: formatVoucherDate(receipt.voucherDate) },
          { label: 'Received From', value: receipt.lines.map((line) => line.counterparty).join(', ') },
          { label: 'Amount', value: `${company.currencyCode} ${formatMoney(receipt.grandTotal)}` },
          { label: 'Amount in words', value: amountInWords(receipt.grandTotal) },
          { label: 'Method', value: receipt.paymentMethod.toUpperCase() },
          ...cheque,
          { label: labels.collectorLabel, value: receipt.collectedByName ?? '-' },
          { label: 'Comment', value: receipt.comments ?? '' },
        ],
        2,
        p,
      ),
      ...(receipt.cancelled
        ? [{ text: `CANCELLED: ${receipt.cancelled.reason ?? '-'}`, bold: true, color: '#b00020' } as Content]
        : []),
      ...signatureRow(labels.signatures, p),
    ],
    footer: footerFor(data, p, null),
    styles: stylesFor(p),
    defaultStyle: { fontSize: p.fontSize },
  };
}

/**
 * Plain invoice / return note (non-VAT): no logo, company name, address, TRN
 * or VAT. Number, date, customer, items, discounts, grand total, amount in
 * words; the ORIGINAL/DUPLICATE marker stays. `company.plainHeaderText` is
 * the only text above it.
 */
export function buildPlainInvoicePdf(data: VoucherPdfData, labels: VoucherPdfLabels): TDocumentDefinitions {
  const { company, voucher } = data;
  const p = presetFor(data.size);
  const items = voucher.items!;
  const header: Content = p.stacked
    ? { stack: [{ text: company.plainHeaderText ?? '' }, { ...copyBox(data), margin: [0, 4, 0, 0] }] }
    : { columns: [{ text: company.plainHeaderText ?? '', width: '*' }, copyBox(data)] };

  return {
    pageSize: p.pageSize,
    pageMargins: p.margins,
    info: { title: `${labels.documentTitle} ${voucher.voucherNo}` },
    ...(voucher.cancelled ? watermarkFor(p) : {}),
    content: [
      header,
      { text: labels.titles.cash, style: 'title' },
      infoTable(
        [
          { label: 'No', value: voucher.voucherNo, bold: true },
          { label: 'Date', value: formatVoucherDate(voucher.voucherDate) },
          { label: labels.headerLabel, value: voucher.headerAccountName },
          ...(voucher.extraInfo ?? []),
        ],
        2,
        p,
      ),
      ...itemLines(items, p, false),
      totalsBlock(
        [
          ['Subtotal', formatMoney(items.subtotal)],
          ...(items.discountTotal > 0 ? [['Discount', `-${formatMoney(items.discountTotal)}`] as [string, string]] : []),
          ...(items.invoiceDiscount > 0 ? [['Invoice Discount', `-${formatMoney(items.invoiceDiscount)}`] as [string, string]] : []),
          [`Grand Total (${company.currencyCode})`, formatMoney(voucher.grandTotal), true],
        ],
        p,
      ),
      { text: [{ text: 'Amount in words: ', bold: true }, amountInWords(voucher.grandTotal)], margin: [0, 0, 0, 8] },
      ...(voucher.cancelled
        ? [{ text: `CANCELLED: ${voucher.cancelled.reason ?? '-'}`, bold: true, color: '#b00020' } as Content]
        : []),
    ],
    footer: footerFor(data, p, null),
    styles: stylesFor(p),
    defaultStyle: { fontSize: p.fontSize },
  };
}

/** Receipt-style lines: counterparty, narration, amount, VAT, net. */
function receiptLines(data: VoucherPdfData, labels: VoucherPdfLabels, p: PrintPreset): Content {
  const lines = data.voucher.lines;
  if (p.stacked) {
    return {
      stack: [
        { text: labels.counterpartyColumn, style: 'tableHeader' },
        separator(p),
        ...lines.flatMap((line): Content[] => [
          { text: line.counterparty, bold: true },
          ...(line.narration ? [{ text: line.narration, style: 'small' } as Content] : []),
          row2('Amount', formatMoney(line.amount)),
          row2('VAT', formatMoney(line.vat)),
          row2('Net', formatMoney(line.netAmount)),
          separator(p),
        ]),
      ],
    };
  }
  return {
    table: {
      headerRows: 1,
      widths: [p.lineCols[0], '*', '*', p.lineCols[1], p.lineCols[2], p.lineCols[3]],
      body: [
        ['#', labels.counterpartyColumn, 'Narration', 'Amount', 'VAT', 'Net'].map((text, i) => ({
          text,
          style: 'tableHeader',
          alignment: i >= 3 ? 'right' : 'left',
        })),
        ...lines.map((line, index) => [
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
}

/** Item-document lines (no narration) and the VAT summary under them. */
function itemLines(items: ItemDocument, p: PrintPreset, withVat = true): Content[] {
  const [qtyW, rateW, totalW] = p.itemCols;
  if (p.stacked) {
    return [
      {
        stack: [
          { text: 'Product', style: 'tableHeader' },
          row2('Qty x Unit price (before VAT)', 'Total', { style: 'small' }),
          separator(p),
          ...items.lines.flatMap((line): Content[] => [
            { text: line.product, bold: true },
            row2(
              `${line.qty} x ${formatMoney(line.rate)}${items.hasLineDiscount && line.discount > 0 ? ` (-${formatMoney(line.discount)})` : ''}`,
              formatMoney(line.total),
            ),
            separator(p),
          ]),
        ],
      },
      ...(withVat
        ? [
            {
              stack: [
                { text: 'VAT summary', style: 'tableHeader', margin: [0, 4, 0, 0] },
                row2('Rate / Taxable amount', 'VAT', { style: 'small' }),
                ...items.vatSummary.map((row) => row2(`${row.rate}% on ${formatMoney(row.taxable)}`, formatMoney(row.vat))),
              ],
            } as Content,
          ]
        : []),
    ];
  }
  const header = (text: string, i: number): TableCell => ({ text, style: 'tableHeader', alignment: i > 0 ? 'right' : 'left' });
  const grey = { hLineColor: BORDER, vLineColor: BORDER, fillColor: (row: number) => (row === 0 ? '#eeeeee' : null) };
  return [
    {
      table: {
        headerRows: 1,
        widths: items.hasLineDiscount ? ['*', qtyW, rateW, rateW, totalW] : ['*', qtyW, rateW, totalW],
        body: [
          (items.hasLineDiscount ? ['Product', 'Qty', 'Unit price', 'Discount', 'Total'] : ['Product', 'Qty', 'Unit price', 'Total']).map(header),
          ...items.lines.map((line) => [
            line.product,
            right(String(line.qty)),
            right(formatMoney(line.rate)),
            ...(items.hasLineDiscount ? [right(line.discount > 0 ? `-${formatMoney(line.discount)}` : '')] : []),
            right(formatMoney(line.total)),
          ]),
        ],
      },
      layout: grey,
    },
    ...(withVat ? [{
      table: {
        headerRows: 1,
        widths: ['*', rateW + 10, totalW],
        body: [
          ['VAT rate', 'Taxable amount', 'VAT'].map(header),
          ...items.vatSummary.map((row) => [
            `${row.rate}%`,
            right(formatMoney(row.taxable)),
            right(formatMoney(row.vat)),
          ]),
        ],
      },
      layout: grey,
      margin: [0, 8, 0, 0],
    } as Content] : []),
  ];
}

/** Voucher layout at the data's page size (a4 when unset). Pure: the same data always gives the same definition. */
export function buildVoucherPdf(data: VoucherPdfData, labels: VoucherPdfLabels): TDocumentDefinitions {
  const { company, voucher: receipt } = data;
  const p = presetFor(data.size);
  const items = receipt.items;
  const isCancelled = receipt.cancelled !== null;

  const companyBlock: Content[] = [
    { text: company.legalName, style: 'companyName' },
    ...company.addressLines.map((line): Content => ({ text: line, style: 'companyLine' })),
    ...(company.phone ? [{ text: `Tel: ${company.phone}`, style: 'companyLine' } as Content] : []),
    ...(company.trn ? [{ text: `TRN: ${company.trn}`, style: 'companyLine' } as Content] : []),
  ];
  const logo: Content[] =
    company.logoDataUrl && !p.thermal
      ? [{ image: company.logoDataUrl, fit: p.stacked ? [40, 30] : [80, 60], width: p.stacked ? 46 : 90 } as Content]
      : [];

  const header: Content = p.stacked
    ? {
        stack: [
          { columns: [...logo, { stack: companyBlock, width: '*' }], columnGap: 8 },
          { ...copyBox(data), margin: [0, 4, 0, 0] },
        ],
      }
    : { columns: [...logo, { stack: companyBlock, width: '*' }, copyBox(data)], columnGap: 10 };

  const info = infoTable(
    [
      { label: 'Voucher No', value: receipt.voucherNo, bold: true },
      { label: 'Date', value: formatVoucherDate(receipt.voucherDate) },
      { label: labels.headerLabel, value: receipt.headerAccountName },
      { label: labels.collectorLabel, value: receipt.collectedByName ?? '-' },
      ...(receipt.extraInfo ?? []),
      ...(receipt.paymentReference ? [{ label: 'Reference', value: receipt.paymentReference }] : []),
    ],
    4,
    p,
  );

  const totals = items
    ? totalsBlock(
        [
          ['Subtotal', formatMoney(items.subtotal)],
          ...(items.discountTotal > 0 ? [['Discount', `-${formatMoney(items.discountTotal)}`] as [string, string]] : []),
          ...(items.invoiceDiscount > 0 ? [['Invoice Discount', `-${formatMoney(items.invoiceDiscount)}`] as [string, string]] : []),
          ['Total Tax', formatMoney(receipt.totalTax)],
          [`Grand Total (${company.currencyCode})`, formatMoney(receipt.grandTotal), true],
        ],
        p,
      )
    : totalsBlock(
        [
          ['Gross Total', formatMoney(receipt.grossTotal)],
          ['Total Tax', formatMoney(receipt.totalTax)],
          [`Grand Total (${company.currencyCode})`, formatMoney(receipt.grandTotal), true],
        ],
        p,
      );

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

  const showWords = items ? items.showWords : true;

  return {
    pageSize: p.pageSize,
    pageMargins: p.margins,
    info: { title: `${labels.documentTitle} ${receipt.voucherNo}`, author: company.legalName },
    ...(isCancelled ? watermarkFor(p) : {}),
    content: [
      header,
      { text: labels.titles[receipt.paymentMethod] ?? labels.titles.cash, style: 'title' },
      info,
      ...(items ? itemLines(items, p) : [receiptLines(data, labels, p)]),
      totals,
      ...(showWords
        ? [{ text: [{ text: 'Amount in words: ', bold: true }, amountInWords(receipt.grandTotal)], margin: [0, 0, 0, 8] } as Content]
        : []),
      ...(receipt.comments ? [{ text: [{ text: 'Comments: ', bold: true }, receipt.comments] } as Content] : []),
      { text: [{ text: 'Prepared by: ', bold: true }, preparedBy], margin: [0, 6, 0, 0] },
      ...cancellation,
      ...signatureRow(labels.signatures, p),
    ],
    footer: footerFor(data, p, company.footerText),
    styles: stylesFor(p),
    defaultStyle: { fontSize: p.fontSize },
  };
}
