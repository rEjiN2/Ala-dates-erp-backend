import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Role, RoleDocument } from '../../roles/schemas/role.schema.js';

export type UserDocument = HydratedDocument<User>;

/** Entity type under which users appear in audit logs. */
export const USER_ENTITY_TYPE = 'user';

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export const PASSWORD_MIN_LENGTH = 8;

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true, index: true })
  email: string;

  @Prop({ required: true, select: false })
  passwordHash: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: Types.ObjectId, ref: Role.name, required: true, index: true })
  role: Types.ObjectId | RoleDocument;

  @Prop({ type: String, enum: UserStatus, required: true, default: UserStatus.ACTIVE, index: true })
  status: UserStatus;

  /**
   * Before `status` existed. The seed moves it into `status` and removes it;
   * until then isUserActive() still honours a false here.
   */
  @Prop({ type: Boolean })
  isActive?: boolean;

  /** Set on create and on an admin password reset; every route but the password change is refused until cleared. */
  @Prop({ default: false })
  mustChangePassword: boolean;

  /** Cash/wallet accounts a "own"-scoped user may receive money into. */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'LedgerAccount' }], default: [] })
  allowedCashAccountIds: Types.ObjectId[];

  /** Stock-holding locations an "own"-scoped user sees stock for. */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Location' }], default: [] })
  allowedLocationIds: Types.ObjectId[];

  /**
   * Van salesmen: hands collected cash to the office on a cash handover.
   * Their receipts start unsettled; they appear in the salesman report.
   */
  @Prop({ default: false })
  settlesWithOffice: boolean;

  /** Where the user is based (e.g. their van); filters the salesman report. */
  @Prop({ type: Types.ObjectId, ref: 'Location', default: null })
  locationId: Types.ObjectId | null;

  @Prop({ select: false })
  refreshTokenHash?: string;
}

export const UserSchema = SchemaFactory.createForClass(User);

/** Mongo filter for active users, legacy isActive:false documents excluded. */
export const ACTIVE_USER_FILTER = { status: UserStatus.ACTIVE, isActive: { $ne: false } } as const;

export function isUserActive(user: Pick<User, 'status' | 'isActive'>): boolean {
  return user.status === UserStatus.ACTIVE && user.isActive !== false;
}
