import { Injectable } from '@nestjs/common';
import { LedgerAccountService } from '../accounting/ledger-accounts/ledger-account.service.js';
import {
  LedgerAccountStatus,
  LedgerAccountType,
} from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { sum2 } from '../../common/utils/money.util.js';

export interface DashboardAccountBalance {
  id: string;
  code: string;
  name: string;
  status: LedgerAccountStatus;
  balance: number;
}

export interface DashboardBalanceGroup {
  type: LedgerAccountType;
  /** Sum of ACTIVE accounts only. */
  total: number;
  /** Every listed account, active and inactive. */
  accountCount: number;
  accounts: DashboardAccountBalance[];
}

export interface DashboardSummary {
  asOf: string;
  /** One entry per LedgerAccountType, always in enum order, empty types included. */
  balancesByType: DashboardBalanceGroup[];
  /** Active cash + bank + wallet accounts combined: the live liquid-funds figure. */
  cashAndBankTotal: number;
}

const LIQUID_TYPES = new Set([LedgerAccountType.CASH, LedgerAccountType.BANK, LedgerAccountType.WALLET]);

/**
 * Read-only roll-up of figures that actually exist today: the running balances
 * on LedgerAccount, as moved by posted vouchers. Purchase/Sales/stock figures
 * get added here once those modules post real data — nothing is estimated.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly ledgerAccountService: LedgerAccountService) {}

  async getSummary(): Promise<DashboardSummary> {
    // Sorted by code, so each group's account list comes out ordered too.
    const accounts = await this.ledgerAccountService.findAll();

    const balancesByType = Object.values(LedgerAccountType).map((type) => {
      const members = accounts
        .filter((account) => account.type === type)
        .map((account) => ({
          id: account.id as string,
          code: account.code,
          name: account.name,
          status: account.status,
          balance: account.balance,
        }));

      return {
        type,
        // Live balance only: inactive (closed) accounts stay listed below, flagged
        // by `status`, but are never summed.
        total: sum2(
          members
            .filter((account) => account.status === LedgerAccountStatus.ACTIVE)
            .map((account) => account.balance),
        ),
        accountCount: members.length,
        accounts: members,
      };
    });

    return {
      asOf: new Date().toISOString(),
      balancesByType,
      cashAndBankTotal: sum2(
        balancesByType.filter((group) => LIQUID_TYPES.has(group.type)).map((group) => group.total),
      ),
    };
  }
}
