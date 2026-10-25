import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { LedgerAccount } from '../../accounting/ledger-accounts/schemas/ledger-account.schema.js';

export type PartyDocument = HydratedDocument<Party>;

/** Entity type under which parties appear in audit logs, comments and the activity timeline. */
export const PARTY_ENTITY_TYPE = 'party';

export enum PartyKind {
  CUSTOMER = 'customer',
  SUPPLIER = 'supplier',
}

/** systemKey of the seeded walk-in customer: holds no credit, every sale to it is paid in full at sale. */
export const CASH_CUSTOMER_KEY = 'cash_customer';

export enum PartyStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/** Case-insensitive comparison for party names (index and queries must use the same one). */
export const PARTY_NAME_COLLATION = { locale: 'en', strength: 2 } as const;

/** A delivery address. Customers only. */
@Schema()
export class ShippingAddress {
  @Prop({ required: true, trim: true })
  label: string;

  @Prop({ type: String, trim: true, default: null })
  address1: string | null;

  @Prop({ type: String, trim: true, default: null })
  address2: string | null;

  @Prop({ type: String, trim: true, default: null })
  address3: string | null;

  @Prop({ type: String, trim: true, default: null })
  city: string | null;

  @Prop({ type: String, trim: true, default: null })
  state: string | null;

  @Prop({ type: String, trim: true, default: null })
  country: string | null;

  @Prop({ type: String, trim: true, default: null })
  postalCode: string | null;

  @Prop({ type: String, trim: true, default: null })
  telephone: string | null;
}

export const ShippingAddressSchema = SchemaFactory.createForClass(ShippingAddress);

/** A file attached to the party. `fileRef` is a FileAttachment id from the /files module, never a storage key. */
@Schema()
export class PartyDocumentRef {
  @Prop({ type: Types.ObjectId, ref: 'FileAttachment', required: true })
  fileRef: Types.ObjectId;

  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ required: true })
  uploadedAt: Date;
}

export const PartyDocumentRefSchema = SchemaFactory.createForClass(PartyDocumentRef);

/**
 * A customer or supplier. Each party owns exactly one ledger account (type
 * "party" for customers, "supplier" for suppliers), created, renamed,
 * (de)activated and deleted together with it.
 */
@Schema({ timestamps: true, collection: 'parties' })
export class Party {
  // CUS-0001 / SUP-0001, generated per kind; the ledger account gets the same code.
  @Prop({ required: true, unique: true, trim: true, uppercase: true, immutable: true })
  code: string;

  @Prop({ type: String, enum: PartyKind, required: true, immutable: true, index: true })
  kind: PartyKind;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, enum: PartyStatus, required: true, default: PartyStatus.ACTIVE, index: true })
  status: PartyStatus;

  @Prop({ type: String, trim: true, default: null })
  contactPerson: string | null;

  @Prop({ type: String, trim: true, default: null })
  telephone: string | null;

  @Prop({ type: String, trim: true, default: null })
  mobile: string | null;

  @Prop({ type: String, trim: true, lowercase: true, default: null })
  email: string | null;

  @Prop({ type: String, trim: true, default: null })
  address1: string | null;

  @Prop({ type: String, trim: true, default: null })
  address2: string | null;

  @Prop({ type: String, trim: true, default: null })
  address3: string | null;

  @Prop({ type: String, trim: true, default: null })
  city: string | null;

  @Prop({ type: String, trim: true, default: null })
  state: string | null;

  @Prop({ type: String, trim: true, default: null })
  country: string | null;

  @Prop({ type: String, trim: true, default: null })
  postalCode: string | null;

  /** UAE TRN, stored as its 15 digits. */
  @Prop({ type: String, trim: true, default: null })
  vatNumber: string | null;

  @Prop({ type: Number, min: 0, default: null })
  creditLimit: number | null;

  @Prop({ type: Number, min: 0, default: null })
  creditDays: number | null;

  /** Free text until a salesman master exists. */
  @Prop({ type: String, trim: true, default: null })
  salesman: string | null;

  @Prop({ type: [ShippingAddressSchema], default: [] })
  shippingAddresses: (ShippingAddress & { _id: Types.ObjectId })[];

  @Prop({ type: [PartyDocumentRefSchema], default: [] })
  documents: (PartyDocumentRef & { _id: Types.ObjectId })[];

  @Prop({ type: Types.ObjectId, ref: LedgerAccount.name, required: true, unique: true })
  ledgerAccountId: Types.ObjectId;

  /** Set only on parties the system seeds (Cash Customer); never deleted through the API. */
  @Prop({ type: String, unique: true, sparse: true, immutable: true })
  systemKey?: string | null;
}

export const PartySchema = SchemaFactory.createForClass(Party);

// Among active parties of one kind: no two with the same name (ignoring case)
// or the same TRN. Inactive parties are exempt. The service checks first for
// a clear message; these are the race-proof backstop.
PartySchema.index(
  { kind: 1, name: 1 },
  {
    name: 'uniq_active_party_name',
    unique: true,
    collation: PARTY_NAME_COLLATION,
    partialFilterExpression: { status: PartyStatus.ACTIVE },
  },
);
PartySchema.index(
  { kind: 1, vatNumber: 1 },
  {
    name: 'uniq_active_party_vat',
    unique: true,
    partialFilterExpression: { status: PartyStatus.ACTIVE, vatNumber: { $type: 'string' } },
  },
);
// List search on telephone; name and code are covered by the indexes above.
PartySchema.index({ telephone: 1 });
