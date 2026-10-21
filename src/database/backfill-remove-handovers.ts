import type { Model } from 'mongoose';
import type { CashReceiptDocument } from '../modules/accounting/cash-receipts/schemas/cash-receipt.schema.js';

/**
 * Cash handovers were removed: unlocks every receipt that was submitted or
 * settled on one by dropping its settlement fields, so it can be edited and
 * cancelled again. The cash_handovers collection is left in place. Safe to
 * re-run: receipts without the fields are untouched.
 */
export async function backfillRemoveHandovers(receiptModel: Model<CashReceiptDocument>): Promise<{ unlocked: number }> {
  const result = await receiptModel.collection.updateMany(
    { $or: [{ settlementStatus: { $exists: true } }, { handoverId: { $exists: true } }, { settledAt: { $exists: true } }] },
    { $unset: { settlementStatus: 1, handoverId: 1, settledAt: 1 } },
  );
  return { unlocked: result.modifiedCount };
}
