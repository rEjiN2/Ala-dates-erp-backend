import type { Collection } from 'mongoose';

/** Sales invoices and returns saved before invoiceKind existed are tax. Only documents lacking it are touched, so it is safe to re-run. */
export async function backfillInvoiceKind(collections: Collection[]): Promise<number> {
  let updated = 0;
  for (const collection of collections) {
    const result = await collection.updateMany({ invoiceKind: { $exists: false } }, { $set: { invoiceKind: 'tax' } });
    updated += result.modifiedCount;
  }
  return updated;
}
