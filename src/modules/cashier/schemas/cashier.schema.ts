import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Location } from '../../location/schemas/location.schema.js';

export type CashierDocument = HydratedDocument<Cashier>;

/** Entity type under which cashiers appear in audit logs and the activity timeline. */
export const CASHIER_ENTITY_TYPE = 'cashier';

export enum CashierStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/** Case-insensitive comparison for cashier names (index and queries must use the same one). */
export const CASHIER_NAME_COLLATION = { locale: 'en', strength: 2 } as const;

@Schema({ timestamps: true, collection: 'cashiers' })
export class Cashier {
  // Generated on create and never changed afterwards.
  @Prop({ required: true, unique: true, trim: true, uppercase: true, immutable: true })
  code: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, trim: true, default: null })
  mobile: string | null;

  @Prop({ type: String, trim: true, lowercase: true, default: null })
  email: string | null;

  @Prop({ type: String, enum: CashierStatus, required: true, default: CashierStatus.ACTIVE, index: true })
  status: CashierStatus;

  /** The app user who works as this cashier, if any; at most one cashier per user. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  linkedUserId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: Location.name, default: null, index: true })
  locationId: Types.ObjectId | null;

  @Prop({ type: String, trim: true, default: null })
  notes: string | null;
}

export const CashierSchema = SchemaFactory.createForClass(Cashier);

// Two active cashiers can't share a name (case-insensitively); an inactive one
// can, so a name frees up when its cashier is deactivated. The service checks
// first for a friendly message; these indexes are the race-proof backstop.
CashierSchema.index(
  { name: 1 },
  {
    name: 'uniq_active_cashier_name',
    unique: true,
    collation: CASHIER_NAME_COLLATION,
    partialFilterExpression: { status: CashierStatus.ACTIVE },
  },
);
CashierSchema.index(
  { linkedUserId: 1 },
  {
    name: 'uniq_cashier_linked_user',
    unique: true,
    partialFilterExpression: { linkedUserId: { $type: 'objectId' } },
  },
);
