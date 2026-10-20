import type { Model } from 'mongoose';
import type { CashierDocument } from '../modules/cashier/schemas/cashier.schema.js';
import type { CashReceiptDocument } from '../modules/accounting/cash-receipts/schemas/cash-receipt.schema.js';
import type { CashHandoverDocument } from '../modules/accounting/cash-handovers/schemas/cash-handover.schema.js';

/**
 * Data from before handover approval:
 * - receipts of staff who settle with the office count as settled on their
 *   voucher date (their cash went over on the old handovers); every other
 *   receipt gets settlementStatus null;
 * - posted handovers become approved, received = expected = their amount,
 *   into their single line's account, approved by whoever entered them.
 * Only touches documents without the new fields, so it is safe to re-run.
 */
export async function backfillHandoverApproval(models: {
  cashier: Model<CashierDocument>;
  receipt: Model<CashReceiptDocument>;
  handover: Model<CashHandoverDocument>;
}): Promise<{ settledReceipts: number; otherReceipts: number; approvedHandovers: number }> {
  const settling = await models.cashier.collection.distinct('_id', { settlesWithOffice: true });
  const fresh = { settlementStatus: { $exists: false } };

  const settled = await models.receipt.collection.updateMany(
    { ...fresh, status: { $ne: 'cancelled' }, cashierId: { $in: settling } },
    [{ $set: { settlementStatus: 'settled', settledAt: '$voucherDate', handoverId: null } }],
  );
  const others = await models.receipt.collection.updateMany(fresh, {
    $set: { settlementStatus: null, settledAt: null, handoverId: null },
  });
  const approved = await models.handover.collection.updateMany(
    { status: { $in: ['posted', null] }, expectedCash: { $exists: false } },
    [
      {
        $set: {
          status: 'approved',
          receipts: [],
          expectedCash: '$grandTotal',
          bankTotal: 0,
          countedCash: '$grandTotal',
          receivedCash: '$grandTotal',
          receivedIntoAccountId: { $ifNull: [{ $first: '$lines.accountId' }, null] },
          varianceReason: null,
          approvedBy: { $ifNull: ['$createdBy', null] },
          approvedAt: { $ifNull: ['$createdAt', '$voucherDate'] },
        },
      },
    ],
  );
  return {
    settledReceipts: settled.modifiedCount,
    otherReceipts: others.modifiedCount,
    approvedHandovers: approved.modifiedCount,
  };
}
