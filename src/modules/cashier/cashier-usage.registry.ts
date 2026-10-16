import { Injectable } from '@nestjs/common';
import type { ClientSession, Types } from 'mongoose';

/** Resolves true when `cashierId` is referenced by the registering module's records. */
export type CashierUsageCheck = (cashierId: Types.ObjectId, session?: ClientSession) => Promise<boolean>;

/**
 * Collects "is this cashier referenced?" checks from every voucher module, so
 * deleting a cashier can be refused without CashierService depending on them
 * (they already depend on it). Same pattern as LedgerAccountUsageRegistry.
 */
@Injectable()
export class CashierUsageRegistry {
  private readonly checks = new Map<string, CashierUsageCheck>();

  /** `source` names the referencing records in error messages, e.g. "cash receipts". */
  register(source: string, check: CashierUsageCheck): void {
    this.checks.set(source, check);
  }

  async findUsage(cashierId: Types.ObjectId, session?: ClientSession): Promise<string | null> {
    for (const [source, check] of this.checks) {
      if (await check(cashierId, session)) {
        return source;
      }
    }
    return null;
  }
}
