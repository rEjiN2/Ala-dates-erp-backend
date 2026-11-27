/**
 * Read-only: `pnpm check:integrity`. Lists parties, ledger accounts, locations
 * and users that reference a ledger account, location or user that no longer
 * exists. Prints nothing (exit 0) on a clean database; exit 1 when it finds any.
 */
import mongoose from 'mongoose';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the shell environment.
}
if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set (in .env or the environment)');
  process.exit(2);
}

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db!;

const ids = async (collection: string): Promise<Set<string>> =>
  new Set((await db.collection(collection).find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
const [accounts, locations, users] = await Promise.all([ids('ledger_accounts'), ids('locations'), ids('users')]);

let problems = 0;
async function check(collection: string, field: string, known: Set<string>, target: string): Promise<void> {
  const docs = await db
    .collection(collection)
    .find({ [field]: { $nin: [null, undefined] } }, { projection: { code: 1, name: 1, [field]: 1 } })
    .toArray();
  for (const doc of docs) {
    if (known.has(String(doc[field]))) continue;
    problems += 1;
    console.log(`${collection} ${doc.code ?? doc._id} (${doc.name ?? '-'}): ${field} ${doc[field]} -> missing ${target}`);
  }
}

await check('parties', 'ledgerAccountId', accounts, 'ledger account');
await check('ledger_accounts', 'locationId', locations, 'location');
await check('ledger_accounts', 'holderUserId', users, 'user');
await check('locations', 'parentId', locations, 'location');
await check('users', 'locationId', locations, 'location');

await mongoose.disconnect();
process.exitCode = problems > 0 ? 1 : 0;
