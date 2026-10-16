import type { Model } from 'mongoose';
import type { CashReceiptDocument } from '../modules/accounting/cash-receipts/schemas/cash-receipt.schema.js';

export interface CashReceiptCashierBackfillResult {
  /** Receipts whose free-text `cashier` moved into `cashierName`. */
  migrated: number;
}

/**
 * One-time (but safely re-runnable) step for receipts entered while the
 * cashier was free text: moves that text into cashierName, sets cashierId to
 * null and removes the old field. No cashier is guessed from the text: such a
 * receipt is given a real cashier the next time someone edits it.
 *
 * Runs through the raw collection because the old `cashier` field is no
 * longer in the schema. A receipt that already has cashierName (or a
 * cashierId) is left alone, so a re-run changes nothing.
 */
export async function backfillCashReceiptCashiers(
  cashReceiptModel: Model<CashReceiptDocument>,
): Promise<CashReceiptCashierBackfillResult> {
  const result = await cashReceiptModel.collection.updateMany(
    { cashier: { $exists: true }, cashierId: { $in: [null] }, cashierName: { $in: [null] } },
    [
      {
        $set: {
          cashierId: null,
          cashierName: {
            $let: {
              vars: { text: { $trim: { input: { $ifNull: [{ $toString: '$cashier' }, ''] } } } },
              in: { $cond: [{ $eq: ['$$text', ''] }, null, '$$text'] },
            },
          },
        },
      },
      { $unset: 'cashier' },
    ],
  );
  return { migrated: result.modifiedCount };
}
