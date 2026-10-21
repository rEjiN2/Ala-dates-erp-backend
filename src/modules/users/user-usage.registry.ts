import { Injectable } from '@nestjs/common';
import type { ClientSession, Types } from 'mongoose';

/** Resolves true when `userId` is referenced by the registering module's records. */
export type UserUsageCheck = (userId: Types.ObjectId, session?: ClientSession) => Promise<boolean>;

/**
 * Collects "is this user referenced?" checks from every voucher module (as
 * Collected By / Paid By), so deleting a user can be refused without the
 * users module depending on them (they already depend on it). Same pattern
 * as LedgerAccountUsageRegistry.
 */
@Injectable()
export class UserUsageRegistry {
  private readonly checks = new Map<string, UserUsageCheck>();

  /** `source` names the referencing records in error messages, e.g. "cash receipts". */
  register(source: string, check: UserUsageCheck): void {
    this.checks.set(source, check);
  }

  async findUsage(userId: Types.ObjectId, session?: ClientSession): Promise<string | null> {
    for (const [source, check] of this.checks) {
      if (await check(userId, session)) {
        return source;
      }
    }
    return null;
  }
}
