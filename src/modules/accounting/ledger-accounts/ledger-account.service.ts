import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, QueryFilter } from 'mongoose';
import {
  BankDetails,
  LedgerAccount,
  LedgerAccountDocument,
  LedgerAccountScope,
  LedgerAccountStatus,
  LedgerAccountType,
  SCOPE_ACCOUNT_TYPES,
  SYSTEM_MANAGED_ACCOUNT_TYPES,
} from './schemas/ledger-account.schema.js';
import { CreateLedgerAccountDto } from './dto/create-ledger-account.dto.js';
import { UpdateLedgerAccountDto } from './dto/update-ledger-account.dto.js';
import { BankDetailsDto } from './dto/bank-details.dto.js';
import { LedgerAccountLookupQueryDto, LedgerAccountQueryDto } from './dto/ledger-account-query.dto.js';
import { LEDGER_ACCOUNT_CODE_SEQUENCES } from './ledger-account-code.js';
import { LedgerAccountUsageRegistry } from './ledger-account-usage.registry.js';
import { LocationService } from '../../location/location.service.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { escapeRegExp } from '../../sequence/code-sequence.js';
import { round2 } from '../../../common/utils/money.util.js';
import { runInTransaction } from '../../../common/utils/transaction.util.js';

/** Account types a voucher header may use by default (payments). */
export const RECEIPT_ACCOUNT_TYPES: readonly LedgerAccountType[] = [
  LedgerAccountType.CASH,
  LedgerAccountType.WALLET,
  LedgerAccountType.BANK,
];

/** Cash-like accounts a user holds money in: what a van salesman hands over. */
export const CASH_LIKE_ACCOUNT_TYPES: readonly LedgerAccountType[] = [
  LedgerAccountType.CASH,
  LedgerAccountType.WALLET,
  LedgerAccountType.CHEQUE,
];

export interface LedgerAccountPage {
  items: LedgerAccountDocument[];
  total: number;
  page: number;
  limit: number;
}

export interface LedgerAccountLookupItem {
  id: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  balance: number;
}

@Injectable()
export class LedgerAccountService {
  constructor(
    @InjectModel(LedgerAccount.name) private readonly ledgerAccountModel: Model<LedgerAccountDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly sequenceService: SequenceService,
    private readonly locationService: LocationService,
    private readonly usageRegistry: LedgerAccountUsageRegistry,
  ) {
    usageRegistry.register('bank accounts (as their bank charge account)', async (accountId, session) =>
      Boolean(
        await this.ledgerAccountModel
          .exists({ 'bankDetails.bankChargeAccountId': accountId })
          .session(session ?? null)
          .exec(),
      ),
    );
  }

  /** Every account, unpaginated. For internal roll-ups such as the dashboard. */
  async findAll(type?: LedgerAccountType): Promise<LedgerAccountDocument[]> {
    const filter: QueryFilter<LedgerAccountDocument> = type ? { type } : {};
    return this.ledgerAccountModel.find(filter).sort({ code: 1 }).exec();
  }

  async list(query: LedgerAccountQueryDto): Promise<LedgerAccountPage> {
    const filter: QueryFilter<LedgerAccountDocument> = {
      ...this.searchFilter(query.q, ['code', 'legacyCode', 'name']),
      type: {
        $in: this.allowedTypes(query.scope ?? LedgerAccountScope.COMPANY, query.type ? [query.type] : undefined),
      },
    };
    if (query.status) filter.status = query.status;

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [items, total] = await Promise.all([
      this.ledgerAccountModel
        .find(filter)
        .sort({ code: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.ledgerAccountModel.countDocuments(filter).exec(),
    ]);

    return { items, total, page, limit };
  }

  /** Active accounts only, for voucher dropdowns: an inactive account can't be posted to. */
  async lookup(query: LedgerAccountLookupQueryDto): Promise<LedgerAccountLookupItem[]> {
    const filter: QueryFilter<LedgerAccountDocument> = {
      ...this.searchFilter(query.q, ['code', 'name']),
      status: LedgerAccountStatus.ACTIVE,
    };
    if (query.scope || query.types?.length) {
      filter.type = { $in: this.allowedTypes(query.scope, query.types) };
    }

    const accounts = await this.ledgerAccountModel
      .find(filter)
      .select('code name type balance')
      .sort({ code: 1 })
      .limit(query.limit ?? 50)
      .lean()
      .exec();

    return accounts.map((account) => ({
      id: account._id.toString(),
      code: account.code,
      name: account.name,
      type: account.type,
      balance: account.balance,
    }));
  }

  async findById(id: string, session?: ClientSession): Promise<LedgerAccountDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Ledger account id "${id}" is not a valid id`);
    }
    const account = await this.ledgerAccountModel
      .findById(id)
      .session(session ?? null)
      .exec();
    if (!account) {
      throw new NotFoundException(`Ledger account ${id} not found`);
    }
    return account;
  }

  async create(dto: CreateLedgerAccountDto): Promise<LedgerAccountDocument> {
    const sequence = LEDGER_ACCOUNT_CODE_SEQUENCES[dto.type];
    if (!sequence) {
      throw this.systemManagedError(dto.type, 'created');
    }
    await this.assertTypeSpecificFields(dto.type, dto);

    return this.inTransaction(
      async (session) => {
        // Inside the transaction: a failed insert (e.g. duplicate name) rolls the
        // counter back too, so codes stay gapless.
        const code = await this.sequenceService.nextCode(sequence, session);
        const [created] = await this.ledgerAccountModel.create(
          [
            {
              code,
              name: dto.name,
              type: dto.type,
              balance: 0,
              status: dto.status ?? LedgerAccountStatus.ACTIVE,
              locationId: dto.locationId ? new Types.ObjectId(dto.locationId) : null,
              bankDetails: dto.bankDetails ? this.toBankDetails(dto.bankDetails) : null,
            },
          ],
          { session },
        );
        return created;
      },
      { type: dto.type, name: dto.name },
    );
  }

  async update(id: string, dto: UpdateLedgerAccountDto): Promise<LedgerAccountDocument> {
    const existing = await this.findById(id);
    this.assertNotSystemManaged(existing, 'updated');
    await this.assertTypeSpecificFields(existing.type, dto);

    if (dto.name !== undefined) existing.name = dto.name;
    if (dto.status !== undefined) existing.status = dto.status;
    if (dto.locationId !== undefined) {
      existing.locationId = dto.locationId ? new Types.ObjectId(dto.locationId) : null;
    }
    if (dto.bankDetails !== undefined) {
      existing.bankDetails = dto.bankDetails ? this.toBankDetails(dto.bankDetails) : null;
    }

    try {
      return await existing.save();
    } catch (error) {
      throw this.toFriendlyError(error, existing.type, existing.name);
    }
  }

  /**
   * Only an unused account with a zero balance can be deleted; anything else
   * should be deactivated, which keeps its history intact.
   */
  async remove(id: string): Promise<{ success: true }> {
    return this.inTransaction(async (session) => {
      const existing = await this.findById(id, session);
      this.assertNotSystemManaged(existing, 'deleted');

      if (round2(existing.balance) !== 0) {
        throw new ConflictException(
          `Cannot delete ${existing.code} (${existing.name}): its balance is ${round2(existing.balance)}, not 0. Deactivate it instead.`,
        );
      }

      const usedBy = await this.usageRegistry.findUsage(existing._id, session);
      if (usedBy) {
        throw new ConflictException(
          `Cannot delete ${existing.code} (${existing.name}): it is used by ${usedBy}. Deactivate it instead.`,
        );
      }

      // Same transaction as the checks: a voucher posting to this account
      // concurrently writes the same document, so one of the two is retried.
      await this.ledgerAccountModel.deleteOne({ _id: existing._id }, { session }).exec();
      return { success: true as const };
    });
  }

  /**
   * Creates the ledger account behind a party or supplier. Only the Parties
   * module calls this, always inside its own transaction, so the two records
   * are created or rolled back together. The balance always starts at 0:
   * opening balances are posted separately.
   */
  async createSystemAccount(
    input: { code: string; name: string; type: LedgerAccountType; status: LedgerAccountStatus },
    session: ClientSession,
  ): Promise<LedgerAccountDocument> {
    this.assertSystemManagedType(input.type);
    try {
      const [created] = await this.ledgerAccountModel.create(
        [{ code: input.code, name: input.name, type: input.type, balance: 0, status: input.status }],
        { session },
      );
      return created;
    } catch (error) {
      throw this.toFriendlyError(error, input.type, input.name);
    }
  }

  /** Keeps a party/supplier ledger account's name and status in step with its party. Caller's transaction only. */
  async syncSystemAccount(
    id: Types.ObjectId,
    changes: { name?: string; status?: LedgerAccountStatus },
    session: ClientSession,
  ): Promise<void> {
    const account = await this.findById(id.toString(), session);
    this.assertSystemManagedType(account.type);
    if (changes.name !== undefined) account.name = changes.name;
    if (changes.status !== undefined) account.status = changes.status;
    try {
      await account.save({ session });
    } catch (error) {
      throw this.toFriendlyError(error, account.type, account.name);
    }
  }

  /** Deletes a party/supplier ledger account. The caller has already checked balance and usage. */
  async deleteSystemAccount(id: Types.ObjectId, session: ClientSession): Promise<void> {
    const account = await this.findById(id.toString(), session);
    this.assertSystemManagedType(account.type);
    await this.ledgerAccountModel.deleteOne({ _id: account._id }, { session }).exec();
  }

  /** The account of this type with this name, ignoring case, or null. */
  async findByTypeAndName(
    type: LedgerAccountType,
    name: string,
    session?: ClientSession,
  ): Promise<LedgerAccountDocument | null> {
    return this.ledgerAccountModel
      .findOne({ type, name: name.trim() })
      .collation({ locale: 'en', strength: 2 })
      .session(session ?? null)
      .exec();
  }

  /** True when any registered module (vouchers, bank details, ...) references the account. */
  async isLedgerAccountUsed(id: string, session?: ClientSession): Promise<boolean> {
    return (await this.usageRegistry.findUsage(new Types.ObjectId(id), session)) !== null;
  }

  /**
   * Resolves the "received into" account of a receipt voucher: an active
   * cash, wallet or bank account. Anything else is rejected.
   */
  async findActiveReceiptAccount(
    id: string,
    types: readonly LedgerAccountType[] = RECEIPT_ACCOUNT_TYPES,
  ): Promise<LedgerAccountDocument> {
    const account = await this.findById(id);

    if (!types.includes(account.type)) {
      throw new BadRequestException(
        `${account.code} (${account.name}) is a ${account.type} account. Choose a ${types.length > 1 ? `${types.slice(0, -1).join(', ')} or ` : ''}${types.at(-1)} account.`,
      );
    }
    if (account.status !== LedgerAccountStatus.ACTIVE) {
      throw new BadRequestException(`Ledger account ${account.code} is inactive`);
    }

    return account;
  }

  /** Balance snapshot for the given accounts. Missing accounts are simply absent from the map. */
  async getBalances(ids: readonly string[], session?: ClientSession): Promise<Map<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }

    const objectIds = ids.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    const accounts = await this.ledgerAccountModel
      .find({ _id: { $in: objectIds } })
      .select('balance')
      .session(session ?? null)
      .lean()
      .exec();

    return new Map(accounts.map((account) => [account._id.toString(), account.balance]));
  }

  /** code, name and type of each account, keyed by id. Missing accounts are simply absent from the map. */
  async getSummaries(
    ids: readonly string[],
    session?: ClientSession,
  ): Promise<Map<string, { code: string; name: string; type: LedgerAccountType }>> {
    const objectIds = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) {
      return new Map();
    }
    const accounts = await this.ledgerAccountModel
      .find({ _id: { $in: objectIds } })
      .select('code name type')
      .session(session ?? null)
      .lean()
      .exec();
    return new Map(
      accounts.map((account) => [
        account._id.toString(),
        { code: account.code, name: account.name, type: account.type },
      ]),
    );
  }

  /** Account names for display (lists, audit diffs). Missing accounts are simply absent from the map. */
  async getNames(ids: readonly string[], session?: ClientSession): Promise<Map<string, string>> {
    const objectIds = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) {
      return new Map();
    }

    const accounts = await this.ledgerAccountModel
      .find({ _id: { $in: objectIds } })
      .select('name')
      .session(session ?? null)
      .lean()
      .exec();

    return new Map(accounts.map((account) => [account._id.toString(), account.name]));
  }

  /**
   * Applies signed balance movements. Always call inside the caller's transaction:
   * an unmatched id throws here, which is what aborts a half-posted voucher.
   */
  async applyBalanceDeltas(deltas: ReadonlyMap<string, number>, session: ClientSession): Promise<void> {
    for (const [accountId, delta] of deltas) {
      if (!Types.ObjectId.isValid(accountId)) {
        throw new BadRequestException(`Ledger account id "${accountId}" is not a valid id`);
      }
      if (round2(delta) === 0) {
        continue;
      }

      const result = await this.ledgerAccountModel
        .updateOne({ _id: new Types.ObjectId(accountId) }, { $inc: { balance: round2(delta) } }, { session })
        .exec();

      if (result.matchedCount === 0) {
        throw new NotFoundException(`Ledger account ${accountId} not found`);
      }
    }
  }

  /** locationId belongs to cash accounts and bankDetails to bank accounts; both refs must resolve. */
  private async assertTypeSpecificFields(
    type: LedgerAccountType,
    fields: { locationId?: string | null; bankDetails?: BankDetailsDto | null },
  ): Promise<void> {
    if (fields.locationId) {
      if (type !== LedgerAccountType.CASH) {
        throw new BadRequestException(`locationId is only allowed on cash accounts, not on a ${type} account`);
      }
      await this.locationService.findById(fields.locationId);
    }

    if (fields.bankDetails) {
      if (type !== LedgerAccountType.BANK) {
        throw new BadRequestException(`bankDetails are only allowed on bank accounts, not on a ${type} account`);
      }
      const chargeAccountId = fields.bankDetails.bankChargeAccountId;
      if (chargeAccountId) {
        const chargeAccount = await this.findById(chargeAccountId);
        if (chargeAccount.type !== LedgerAccountType.EXPENSE) {
          throw new BadRequestException(
            `bankChargeAccountId must be an expense account; ${chargeAccount.code} is a ${chargeAccount.type} account`,
          );
        }
      }
    }
  }

  private toBankDetails(dto: BankDetailsDto): BankDetails {
    return {
      bankName: dto.bankName,
      accountNumber: dto.accountNumber,
      iban: dto.iban,
      swiftCode: dto.swiftCode,
      branchCode: dto.branchCode,
      bankChargeAccountId: dto.bankChargeAccountId ? new Types.ObjectId(dto.bankChargeAccountId) : null,
      commissionPercent: dto.commissionPercent,
      isMerchantAccount: dto.isMerchantAccount ?? false,
    };
  }

  private assertNotSystemManaged(account: LedgerAccountDocument, action: string): void {
    if (SYSTEM_MANAGED_ACCOUNT_TYPES.includes(account.type)) {
      throw this.systemManagedError(account.type, action);
    }
  }

  /** Types a query may return: the scope's types, narrowed further by an explicit type list. Empty means no match. */
  private allowedTypes(
    scope: LedgerAccountScope | undefined,
    types: readonly LedgerAccountType[] | undefined,
  ): LedgerAccountType[] {
    const inScope = scope ? SCOPE_ACCOUNT_TYPES[scope] : Object.values(LedgerAccountType);
    return types?.length ? inScope.filter((type) => types.includes(type)) : [...inScope];
  }

  private assertSystemManagedType(type: LedgerAccountType): void {
    if (!SYSTEM_MANAGED_ACCOUNT_TYPES.includes(type)) {
      throw new BadRequestException(`Only party and supplier accounts are managed by the Parties module, not ${type}`);
    }
  }

  private systemManagedError(type: LedgerAccountType, action: string): ForbiddenException {
    return new ForbiddenException(
      `${type} accounts are system-managed and cannot be ${action} through the Accounts API; they change only via the Parties module`,
    );
  }

  private searchFilter(q: string | undefined, fields: string[]): QueryFilter<LedgerAccountDocument> {
    const term = q?.trim();
    if (!term) {
      return {};
    }
    const pattern = new RegExp(escapeRegExp(term), 'i');
    return { $or: fields.map((field) => ({ [field]: pattern })) };
  }

  private async inTransaction<T>(
    work: (session: ClientSession) => Promise<T>,
    attempted?: { type: LedgerAccountType; name: string },
  ): Promise<T> {
    try {
      return await runInTransaction(this.connection, work);
    } catch (error) {
      throw this.toFriendlyError(error, attempted?.type, attempted?.name);
    }
  }

  private toFriendlyError(error: unknown, type?: LedgerAccountType, name?: string): unknown {
    if (typeof error !== 'object' || error === null || (error as { code?: number }).code !== 11000) {
      return error;
    }
    // keyValue is useless here: under a collation index it holds collation
    // keys, not the name. The attempted type/name come from the caller.
    const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
    if (keyPattern && 'name' in keyPattern) {
      return new ConflictException(`A ${type} account named "${name}" already exists (names are case-insensitive)`);
    }
    return new ConflictException(
      'Generated account code is already in use; the code counter is behind existing data and needs re-syncing (pnpm migrate:ledger-account-codes)',
    );
  }
}
