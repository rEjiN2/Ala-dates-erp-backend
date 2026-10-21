import type { Collection, Model, Types } from 'mongoose';
import type { UserDocument } from '../modules/users/schemas/user.schema.js';

interface OldCashier {
  _id: Types.ObjectId;
  linkedUserId?: Types.ObjectId | null;
  settlesWithOffice?: boolean;
  locationId?: Types.ObjectId | null;
}

/**
 * Moves vouchers from the removed Cashier (Staff) master to users:
 * - collectedById = the cashier's linked login, or null when it had none;
 *   collectedByName keeps the cashier's name as it was on the voucher;
 * - a linked user takes over the cashier's settlesWithOffice and location.
 * The cashiers collection and the old cashierId fields are left in place.
 * Only touches documents without the new fields, so it is safe to re-run.
 */
export async function backfillCollectedBy(models: {
  /** The old cashiers collection (its module is gone; the data stays). */
  cashiers: Collection;
  user: Model<UserDocument>;
  /** Every voucher collection: receipts, payments, handovers. */
  vouchers: Collection[];
}): Promise<{ linkedVouchers: number; unlinkedVouchers: number; users: number }> {
  const cashiers = (await models.cashiers.find({}).toArray()) as unknown as OldCashier[];
  let linkedVouchers = 0;
  let unlinkedVouchers = 0;
  let users = 0;

  for (const cashier of cashiers.filter((candidate) => candidate.linkedUserId)) {
    const moved = await models.user.collection.updateOne(
      { _id: cashier.linkedUserId!, settlesWithOffice: { $exists: false } },
      { $set: { settlesWithOffice: cashier.settlesWithOffice ?? false, locationId: cashier.locationId ?? null } },
    );
    users += moved.modifiedCount;
    for (const vouchers of models.vouchers) {
      const result = await vouchers.updateMany({ cashierId: cashier._id, collectedById: { $exists: false } }, [
        { $set: { collectedById: cashier.linkedUserId, collectedByName: { $ifNull: ['$cashierName', null] } } },
      ]);
      linkedVouchers += result.modifiedCount;
    }
  }
  for (const vouchers of models.vouchers) {
    const result = await vouchers.updateMany({ collectedById: { $exists: false } }, [
      { $set: { collectedById: null, collectedByName: { $ifNull: ['$cashierName', null] } } },
    ]);
    unlinkedVouchers += result.modifiedCount;
  }
  return { linkedVouchers, unlinkedVouchers, users };
}
