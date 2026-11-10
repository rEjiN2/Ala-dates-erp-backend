import { BadRequestException, Injectable } from '@nestjs/common';
import type { Types } from 'mongoose';

/** Same 3-decimal rounding as StockService (not imported: stock.service imports this file). */
const roundQty = (qty: number) => Math.round(qty * 1000) / 1000;

/**
 * Generic "sent, waiting to be received" pattern (stock transfers now, sales
 * return v2 later): the sender's stock leaves at once, the receiver confirms
 * what arrived, and the rest goes back to the sender.
 */
export enum PendingReceiptStatus {
  IN_TRANSIT = 'in_transit',
  RECEIVED = 'received',
  CANCELLED = 'cancelled',
}

/** Per line: what arrives and what goes back. 0 <= received <= sent, else 400 naming the line. */
export function splitReceipt(
  lines: readonly { sent: number; received: number }[],
): { received: number; shortfall: number }[] {
  return lines.map(({ sent, received }, index) => {
    const got = roundQty(received);
    if (!(got >= 0) || got > sent) {
      throw new BadRequestException(`Line ${index + 1}: received quantity must be between 0 and ${sent}`);
    }
    return { received: got, shortfall: roundQty(sent - got) };
  });
}

/** Quantity still in transit per product (key = product id), optionally only toward some locations. */
export type InTransitSource = (
  productIds: Types.ObjectId[],
  toLocationIds: Types.ObjectId[] | null,
) => Promise<Map<string, number>>;

/** Modules with open pending receipts register here; the stock summary adds them up as "in transit". */
@Injectable()
export class InTransitRegistry {
  private readonly sources = new Map<string, InTransitSource>();

  register(source: string, quantities: InTransitSource): void {
    this.sources.set(source, quantities);
  }

  async quantities(productIds: Types.ObjectId[], toLocationIds: Types.ObjectId[] | null): Promise<Map<string, number>> {
    const total = new Map<string, number>();
    for (const quantities of this.sources.values()) {
      for (const [productId, qty] of await quantities(productIds, toLocationIds)) {
        total.set(productId, roundQty((total.get(productId) ?? 0) + qty));
      }
    }
    return total;
  }
}
