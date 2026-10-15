import { Injectable } from '@nestjs/common';
import type { ClientSession, Types } from 'mongoose';

/** Resolves true when `accountId` is referenced by the registering module's records. */
export type LedgerAccountUsageCheck = (accountId: Types.ObjectId, session?: ClientSession) => Promise<boolean>;

/**
 * Collects "is this account referenced?" checks from every module that points
 * at ledger accounts (vouchers, bank details, later purchase/sales/parties).
 *
 * The dependency runs that way round because those modules already import
 * LedgerAccountModule; LedgerAccountService injecting them would be circular.
 * A module registers its check from a provider constructor, so it is in
 * place as soon as the module is instantiated.
 */
@Injectable()
export class LedgerAccountUsageRegistry {
  private readonly checks = new Map<string, LedgerAccountUsageCheck>();

  /** `source` names the referencing records in error messages, e.g. "cash receipts". */
  register(source: string, check: LedgerAccountUsageCheck): void {
    this.checks.set(source, check);
  }

  /** The first source that references the account, or null if none does. */
  async findUsage(accountId: Types.ObjectId, session?: ClientSession): Promise<string | null> {
    for (const [source, check] of this.checks) {
      if (await check(accountId, session)) {
        return source;
      }
    }
    return null;
  }
}
