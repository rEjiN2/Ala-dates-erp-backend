import { Types, type Collection } from 'mongoose';

/**
 * Invoices saved before lines had an _id (sales and purchase returns name a
 * line by it) get a stored, stable one. Without it Mongoose invents a fresh
 * _id on every load, so a return never matches the id the form was given.
 * Only lines lacking an _id are touched, so it is safe to re-run.
 */
export async function backfillInvoiceLineIds(collections: Collection[]): Promise<number> {
  let stamped = 0;
  for (const collection of collections) {
    const cursor = collection.find({ lines: { $elemMatch: { _id: { $exists: false } } } }, { projection: { lines: 1 } });
    for await (const doc of cursor) {
      const set: Record<string, Types.ObjectId> = {};
      (doc.lines as { _id?: unknown }[]).forEach((line, index) => {
        if (!line._id) set[`lines.${index}._id`] = new Types.ObjectId();
      });
      await collection.updateOne({ _id: doc._id }, { $set: set });
      stamped += Object.keys(set).length;
    }
  }
  return stamped;
}
