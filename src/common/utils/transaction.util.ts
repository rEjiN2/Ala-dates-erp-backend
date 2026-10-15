import { InternalServerErrorException } from '@nestjs/common';
import type { ClientSession, Connection } from 'mongoose';

/**
 * Runs `work` in a MongoDB transaction. The driver retries the whole callback
 * on transient errors (e.g. a write conflict with a concurrent transaction),
 * so `work` must do all of its reads through `session` and keep no state
 * outside it between attempts.
 */
export async function runInTransaction<T>(
  connection: Connection,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await connection.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result as T;
  } catch (error) {
    throw toFriendlyTransactionError(error);
  } finally {
    await session.endSession();
  }
}

function toFriendlyTransactionError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('Transaction numbers are only allowed on a replica set member or mongos')) {
    return new InternalServerErrorException(
      'This operation requires MongoDB transactions, which need a replica set. Point MONGODB_URI at a replica set (a single-node one is fine for local dev).',
    );
  }
  return error;
}
