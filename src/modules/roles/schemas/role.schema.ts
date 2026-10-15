import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type RoleDocument = HydratedDocument<Role>;

@Schema({ timestamps: true, collection: 'roles' })
export class Role {
  @Prop({ required: true, unique: true, trim: true })
  name: string;

  @Prop({ type: [String], default: [] })
  permissions: string[];

  @Prop({ trim: true })
  description?: string;
}

export const RoleSchema = SchemaFactory.createForClass(Role);
