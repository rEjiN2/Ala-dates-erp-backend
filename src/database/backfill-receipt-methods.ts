import type { Model } from 'mongoose';
import type { CashReceiptDocument } from '../modules/accounting/cash-receipts/schemas/cash-receipt.schema.js';
import type { LedgerAccountDocument } from '../modules/accounting/ledger-accounts/schemas/ledger-account.schema.js';

/**
 * Gives every receipt an explicit paymentMethod from its received-into
 * account: bank account -> bank, cheque account -> cheque, else cash.
 * Cheque receipts from before the cheque fields get status at_office and
 * their paymentReference as the cheque number. Only fills what is missing
 * or contradicts the account, so it is safe to re-run.
 */
export async function backfillReceiptMethods(models: {
  receipt: Model<CashReceiptDocument>;
  account: Model<LedgerAccountDocument>;
}): Promise<{ bank: number; cheque: number; cash: number }> {
  const idsOf = async (type: string) => models.account.collection.distinct('_id', { type });
  const [banks, cheques] = await Promise.all([idsOf('bank'), idsOf('cheque')]);
  const set = async (filter: Record<string, unknown>, method: string) =>
    (
      await models.receipt.collection.updateMany(
        { ...filter, paymentMethod: { $ne: method } },
        { $set: { paymentMethod: method } },
      )
    ).modifiedCount;

  const bank = await set({ cashAccountId: { $in: banks } }, 'bank');
  const cheque = await set({ cashAccountId: { $in: cheques } }, 'cheque');
  const cash = await set({ cashAccountId: { $nin: [...banks, ...cheques] } }, 'cash');
  await models.receipt.collection.updateMany(
    { paymentMethod: 'cheque', chequeStatus: null },
    [
      {
        $set: {
          chequeStatus: 'at_office',
          chequeNumber: { $ifNull: ['$chequeNumber', '$paymentReference'] },
        },
      },
    ],
  );
  return { bank, cheque, cash };
}
