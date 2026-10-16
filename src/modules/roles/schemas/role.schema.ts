import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { DataScope } from '../permissions.js';

export type RoleDocument = HydratedDocument<Role>;

/** Entity type under which roles appear in audit logs. */
export const ROLE_ENTITY_TYPE = 'role';

/** Case-insensitive comparison for role names (index and queries must use the same one). */
export const ROLE_NAME_COLLATION = { locale: 'en', strength: 2 } as const;

@Schema({ timestamps: true, collection: 'roles' })
export class Role {
  @Prop({ required: true, unique: true, trim: true })
  name: string;

  @Prop({ type: [String], default: [] })
  permissions: string[];

  @Prop({ trim: true })
  description?: string;

  /** "own": the role's users see only vouchers they created or that are on their linked cashier. */
  @Prop({ type: String, enum: DataScope, required: true, default: DataScope.ALL })
  dataScope: DataScope;

  /** Seeded and protected (the admin role): can't be edited or deleted through the API. */
  @Prop({ default: false })
  isSystem: boolean;
}

export const RoleSchema = SchemaFactory.createForClass(Role);
