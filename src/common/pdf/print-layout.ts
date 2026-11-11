import { BadRequestException, Injectable } from '@nestjs/common';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';

export const PRINT_SIZES = ['a4', 'a5', 'a6', 'letter', 'thermal80', 'thermal58'] as const;
export type PrintSize = (typeof PRINT_SIZES)[number];

export const PRINT_DOC_TYPES = ['receipt', 'referenceReceipt', 'taxInvoice', 'nonVatInvoice', 'other'] as const;
export type PrintDocType = (typeof PRINT_DOC_TYPES)[number];
export type PrintDefaults = Record<PrintDocType, PrintSize>;

export const DEFAULT_PRINT_DEFAULTS: PrintDefaults = {
  receipt: 'a5',
  referenceReceipt: 'a5',
  taxInvoice: 'a5',
  nonVatInvoice: 'a5',
  other: 'a4',
};

export interface PrintPreset {
  size: PrintSize;
  pageSize: TDocumentDefinitions['pageSize'];
  /** [left, top, right, bottom] */
  margins: [number, number, number, number];
  /** Printable width in points. */
  contentWidth: number;
  fontSize: number;
  titleSize: number;
  watermarkSize: number;
  /** Single column, items stacked (a6 and thermal). */
  stacked: boolean;
  /** Continuous roll: no logo, no signature boxes, no watermark. */
  thermal: boolean;
  labelWidth: number;
  /** Width of one signature box and its height. */
  signature: { w: number; h: number };
  /** Item table: qty, unit price and total column widths. */
  itemCols: [number, number, number];
  /** Totals table: label and value widths (non-stacked). */
  totalsCols: [number, number];
  /** Receipt-style lines table: #, amount, VAT, net widths ('*' columns take the rest). */
  lineCols: [number, number, number, number];
}

const mm = (value: number) => (value / 25.4) * 72;

function preset(
  size: PrintSize,
  pageSize: PrintPreset['pageSize'],
  pageWidth: number,
  margins: PrintPreset['margins'],
  rest: Omit<PrintPreset, 'size' | 'pageSize' | 'margins' | 'contentWidth'>,
): PrintPreset {
  return { size, pageSize, margins, contentWidth: Math.floor(pageWidth - margins[0] - margins[2]), ...rest };
}

const PRESETS: Record<PrintSize, PrintPreset> = {
  a4: preset('a4', 'A4', 595.28, [40, 40, 40, 60], {
    fontSize: 10, titleSize: 16, watermarkSize: 90, stacked: false, thermal: false, labelWidth: 90,
    signature: { w: 220, h: 55 }, itemCols: [50, 75, 80], totalsCols: [100, 90], lineCols: [18, 65, 55, 70],
  }),
  letter: preset('letter', 'LETTER', 612, [40, 40, 40, 60], {
    fontSize: 10, titleSize: 16, watermarkSize: 90, stacked: false, thermal: false, labelWidth: 90,
    signature: { w: 220, h: 55 }, itemCols: [50, 75, 80], totalsCols: [100, 90], lineCols: [18, 65, 55, 70],
  }),
  a5: preset('a5', 'A5', 419.53, [28, 28, 28, 44], {
    fontSize: 8.5, titleSize: 13, watermarkSize: 64, stacked: false, thermal: false, labelWidth: 68,
    signature: { w: 160, h: 42 }, itemCols: [38, 58, 64], totalsCols: [85, 75], lineCols: [14, 52, 42, 56],
  }),
  a6: preset('a6', 'A6', 297.64, [16, 14, 16, 30], {
    fontSize: 7, titleSize: 11, watermarkSize: 46, stacked: true, thermal: false, labelWidth: 56,
    signature: { w: 118, h: 22 }, itemCols: [30, 46, 52], totalsCols: [90, 80], lineCols: [12, 46, 36, 48],
  }),
  thermal80: preset('thermal80', { width: mm(80), height: 'auto' }, mm(80), [8, 8, 8, 14], {
    fontSize: 7.5, titleSize: 10, watermarkSize: 0, stacked: true, thermal: true, labelWidth: 52,
    signature: { w: 0, h: 0 }, itemCols: [28, 44, 50], totalsCols: [100, 80], lineCols: [12, 44, 34, 46],
  }),
  thermal58: preset('thermal58', { width: mm(58), height: 'auto' }, mm(58), [6, 6, 6, 12], {
    fontSize: 7, titleSize: 9, watermarkSize: 0, stacked: true, thermal: true, labelWidth: 46,
    signature: { w: 0, h: 0 }, itemCols: [24, 38, 42], totalsCols: [80, 60], lineCols: [10, 38, 30, 40],
  }),
};

/** A copy: pdfmake rewrites pageSize.height on 'auto' pages, which must not leak into the shared preset. */
export function presetFor(size: PrintSize = 'a4'): PrintPreset {
  const p = PRESETS[size];
  return {
    ...p,
    pageSize: typeof p.pageSize === 'object' ? { ...p.pageSize } : p.pageSize,
    margins: [...p.margins],
  };
}

/** Shared by every PDF: which size to print at, and the page setup for it. */
@Injectable()
export class PrintLayoutService {
  /**
   * Explicit ?size wins, else the company default for the document type, else
   * the built-in default. An unknown size is a 400. Call before any print side effect.
   */
  resolveSize(
    requested: unknown,
    docType: PrintDocType,
    printDefaults?: Partial<PrintDefaults> | null,
  ): PrintSize {
    if (requested !== undefined && requested !== null && requested !== '') {
      if (typeof requested !== 'string' || !(PRINT_SIZES as readonly string[]).includes(requested)) {
        throw new BadRequestException(`size must be one of: ${PRINT_SIZES.join(', ')}`);
      }
      return requested as PrintSize;
    }
    return printDefaults?.[docType] ?? DEFAULT_PRINT_DEFAULTS[docType];
  }

  preset(size: PrintSize): PrintPreset {
    return presetFor(size);
  }

  /**
   * Page setup for documents that are not built from a preset (transfer,
   * count and bundling notes): page size, margins, font, and fixed table
   * widths scaled to fit the printable width.
   */
  apply(definition: TDocumentDefinitions, size: PrintSize): TDocumentDefinitions {
    const p = presetFor(size);
    const scale = Math.min(1, p.contentWidth / 515);
    const fit = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(fit);
      if (node && typeof node === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) {
          out[key] = key === 'widths' && Array.isArray(value) && scale < 1
            ? value.map((w) => (typeof w === 'number' ? Math.max(24, Math.floor(w * scale)) : w))
            : key === 'heights' && Array.isArray(value) && scale < 1
              ? value.map((h) => (typeof h === 'number' ? Math.max(24, Math.floor(h * scale)) : h))
              : fit(value);
        }
        return out;
      }
      return node;
    };
    return {
      ...definition,
      pageSize: p.pageSize,
      pageMargins: p.margins,
      content: fit(definition.content) as Content,
      defaultStyle: { ...definition.defaultStyle, fontSize: scale < 1 ? p.fontSize : (definition.defaultStyle?.fontSize ?? p.fontSize) },
    };
  }
}

/** Dependency-free, so services that print can share one without extra wiring. */
export const printLayout = new PrintLayoutService();
