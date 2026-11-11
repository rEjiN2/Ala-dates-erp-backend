import { BadRequestException } from '@nestjs/common';
import { round2, sum2 } from '../../../common/utils/money.util.js';

export type DiscountType = 'amount' | 'percent';
export const DISCOUNT_TYPES: readonly DiscountType[] = ['amount', 'percent'];

export interface PricingLineInput {
  qty: number;
  rate: number;
  discountType: DiscountType;
  discountValue: number;
  vatRate: number;
}

export interface PricedLine {
  gross: number;
  discountAmount: number;
  allocatedDiscount: number;
  taxable: number;
  vat: number;
  net: number;
}

export interface PricedInvoice {
  lines: PricedLine[];
  grossTotal: number;
  lineDiscounts: number;
  invoiceDiscount: number;
  taxableTotal: number;
  totalTax: number;
  netTotal: number;
}

const discountOf = (base: number, type: DiscountType, value: number) =>
  round2(type === 'percent' ? (base * value) / 100 : value);

/**
 * Line discounts first, then the invoice discount spread over the lines pro
 * rata to each line's amount after its own discount (largest remainder, in
 * cents, so the shares sum exactly). VAT is on line - line discount - share.
 */
export function priceInvoice(
  inputs: readonly PricingLineInput[],
  header: { discountType: DiscountType; discountValue: number },
): PricedInvoice {
  const afterLine = inputs.map((line, index) => {
    const gross = round2(line.qty * line.rate);
    const discountAmount = discountOf(gross, line.discountType, line.discountValue);
    if (discountAmount > gross) {
      throw new BadRequestException(`Line ${index + 1}: the discount is more than the line value`);
    }
    return { gross, discountAmount, after: round2(gross - discountAmount) };
  });
  const base = sum2(afterLine.map((line) => line.after));
  const invoiceDiscount = discountOf(base, header.discountType, header.discountValue);
  if (invoiceDiscount > base) {
    throw new BadRequestException('The invoice discount is more than the invoice value');
  }

  const shares = spread(
    Math.round(invoiceDiscount * 100),
    afterLine.map((line) => Math.round(line.after * 100)),
  ).map((cents) => cents / 100);

  const lines = afterLine.map((line, index): PricedLine => {
    const allocatedDiscount = shares[index];
    const taxable = round2(line.after - allocatedDiscount);
    if (taxable < 0) {
      throw new BadRequestException(`Line ${index + 1}: the discounts are more than the line value`);
    }
    const vat = round2((taxable * inputs[index].vatRate) / 100);
    return { gross: line.gross, discountAmount: line.discountAmount, allocatedDiscount, taxable, vat, net: round2(taxable + vat) };
  });
  const taxableTotal = sum2(lines.map((line) => line.taxable));
  const totalTax = sum2(lines.map((line) => line.vat));
  if (taxableTotal < 0) {
    throw new BadRequestException('The invoice total cannot be negative');
  }
  return {
    lines,
    grossTotal: sum2(lines.map((line) => line.gross)),
    lineDiscounts: sum2(lines.map((line) => line.discountAmount)),
    invoiceDiscount: sum2(lines.map((line) => line.allocatedDiscount)),
    taxableTotal,
    totalTax,
    netTotal: round2(taxableTotal + totalTax),
  };
}

/** Splits `total` cents over `weights` pro rata; floors, then the biggest remainders get the missing cents. */
function spread(total: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const parts = weights.map((weight, index) => {
    const product = BigInt(total) * BigInt(weight);
    return { index, cents: Number(product / BigInt(sum)), rest: product % BigInt(sum) };
  });
  let missing = total - parts.reduce((acc, part) => acc + part.cents, 0);
  const order = [...parts].sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  for (const part of order) {
    if (missing <= 0) break;
    part.cents += 1;
    missing -= 1;
  }
  return parts.map((part) => part.cents);
}
