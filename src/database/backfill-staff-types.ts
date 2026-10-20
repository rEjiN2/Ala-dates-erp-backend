import type { Model } from 'mongoose';
import { type CashierDocument, StaffType } from '../modules/cashier/schemas/cashier.schema.js';

/**
 * Cashiers from before the Staff fields become plain cashiers who do not
 * settle with the office. Only fills missing fields, so it is safe to re-run
 * and never overrides what an admin has set.
 */
export async function backfillStaffTypes(cashierModel: Model<CashierDocument>): Promise<{ staffType: number; settles: number }> {
  const [staffType, settles] = await Promise.all([
    cashierModel.collection.updateMany({ staffType: { $exists: false } }, { $set: { staffType: StaffType.CASHIER } }),
    cashierModel.collection.updateMany({ settlesWithOffice: { $exists: false } }, { $set: { settlesWithOffice: false } }),
  ]);
  return { staffType: staffType.modifiedCount, settles: settles.modifiedCount };
}
