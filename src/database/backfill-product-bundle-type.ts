import type { Collection } from 'mongoose';

/** Products of the retired type "bundle" become "stock". Recipes are untouched. Returns how many match (and, with apply, were changed). */
export async function backfillProductBundleType(products: Collection, apply: boolean): Promise<number> {
  const filter = { type: 'bundle' };
  if (!apply) return products.countDocuments(filter);
  return (await products.updateMany(filter, { $set: { type: 'stock' } })).modifiedCount;
}
