import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export enum LedgerAccountType {
  CASH = 'cash',
  BANK = 'bank',
  WALLET = 'wallet',
  /** Cheques in hand: cash-like until cleared into a bank (Q27). */
  CHEQUE = 'cheque',
  PARTY = 'party',
  SUPPLIER = 'supplier',
  INCOME = 'income',
  EXPENSE = 'expense',
  OTHER = 'other',
}

/**
 * Accounts the system creates (seed, or on first use) and posts to itself;
 * never chosen on a voucher. Opening Balance Equity is keyed the same way.
 */
export const SYSTEM_ACCOUNTS = {
  PURCHASES: { key: 'purchases', name: 'Purchases', type: LedgerAccountType.EXPENSE },
  VAT_INPUT: { key: 'vat_input', name: 'VAT Input', type: LedgerAccountType.OTHER },
  SALES: { key: 'sales', name: 'Sales', type: LedgerAccountType.INCOME },
  VAT_OUTPUT: { key: 'vat_output', name: 'VAT Output', type: LedgerAccountType.OTHER },
} as const;

export enum LedgerAccountStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * Party and supplier accounts are created, changed and removed only by the
 * Parties module; the Accounts API lists them but never writes them.
 */
export const SYSTEM_MANAGED_ACCOUNT_TYPES: readonly LedgerAccountType[] = [
  LedgerAccountType.PARTY,
  LedgerAccountType.SUPPLIER,
];

/**
 * Company accounts are the business's own (cash, bank, wallet, cheque, income,
 * expense, other); party accounts belong to customers and suppliers and are
 * managed from the Parties module. Lists and pickers never mix the two
 * unless asked to.
 */
export enum LedgerAccountScope {
  COMPANY = 'company',
  PARTY = 'party',
}

export const SCOPE_ACCOUNT_TYPES: Readonly<Record<LedgerAccountScope, readonly LedgerAccountType[]>> = {
  [LedgerAccountScope.COMPANY]: [
    LedgerAccountType.CASH,
    LedgerAccountType.BANK,
    LedgerAccountType.WALLET,
    LedgerAccountType.CHEQUE,
    LedgerAccountType.INCOME,
    LedgerAccountType.EXPENSE,
    LedgerAccountType.OTHER,
  ],
  [LedgerAccountScope.PARTY]: [LedgerAccountType.PARTY, LedgerAccountType.SUPPLIER],
};

export type LedgerAccountDocument = HydratedDocument<LedgerAccount>;

/** Only ever present on bank accounts. */
@Schema({ _id: false })
export class BankDetails {
  @Prop({ trim: true })
  bankName?: string;

  @Prop({ trim: true })
  accountNumber?: string;

  @Prop({ trim: true, uppercase: true })
  iban?: string;

  @Prop({ trim: true, uppercase: true })
  swiftCode?: string;

  @Prop({ trim: true })
  branchCode?: string;

  /** Expense account that bank charges are posted to. */
  @Prop({ type: Types.ObjectId, ref: 'LedgerAccount', default: null })
  bankChargeAccountId?: Types.ObjectId | null;

  @Prop({ min: 0, max: 100 })
  commissionPercent?: number;

  @Prop({ default: false })
  isMerchantAccount?: boolean;
}

export const BankDetailsSchema = SchemaFactory.createForClass(BankDetails);

@Schema({
  timestamps: true,
  collection: 'ledger_accounts',
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class LedgerAccount {
  // Generated per type on create and never changed afterwards. Party/supplier
  // codes come from the Parties module.
  @Prop({ required: true, unique: true, trim: true, uppercase: true, immutable: true })
  code: string;

  /** The hand-entered code an account had before codes were generated, kept for lookup. */
  @Prop({ trim: true })
  legacyCode?: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, required: true, enum: LedgerAccountType, index: true, immutable: true })
  type: LedgerAccountType;

  /** Running balance. Only ever moved by posting a transaction, never set directly. */
  @Prop({ required: true, default: 0 })
  balance: number;

  @Prop({
    type: String,
    required: true,
    enum: LedgerAccountStatus,
    default: LedgerAccountStatus.ACTIVE,
  })
  status: LedgerAccountStatus;

  /** Cash accounts only: the location (store, van, ...) the cash physically sits at. */
  @Prop({ type: Types.ObjectId, ref: 'Location', default: null, index: true })
  locationId: Types.ObjectId | null;

  @Prop({ type: BankDetailsSchema, default: null })
  bankDetails: BankDetails | null;

  /**
   * Set only on accounts the system creates and owns (Opening Balance Equity, SYSTEM_ACCOUNTS):
   * never edited or deleted through the API, never offered or accepted on a voucher.
   */
  @Prop({ type: String, unique: true, sparse: true, immutable: true })
  systemKey?: string;

  /** Virtual, derived from type and systemKey. */
  isSystemManaged?: boolean;
}

export const LedgerAccountSchema = SchemaFactory.createForClass(LedgerAccount);

LedgerAccountSchema.virtual('isSystemManaged').get(function (this: LedgerAccount) {
  return SYSTEM_MANAGED_ACCOUNT_TYPES.includes(this.type) || Boolean(this.systemKey);
});

// Name is unique within a type, ignoring case ("Main Cash" == "main cash").
LedgerAccountSchema.index(
  { type: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 }, name: 'type_name_ci_unique' },
);
