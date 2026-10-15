import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export enum LocationType {
  BRANCH = 'branch',
  WAREHOUSE = 'warehouse',
  STORE = 'store',
  VAN = 'van',
}

export enum LocationStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export type LocationDocument = HydratedDocument<Location>;

@Schema({ timestamps: true, collection: 'locations' })
export class Location {
  // Generated on create and never changed afterwards; `immutable` makes
  // Mongoose drop any later assignment or $set. The unique index stays as a
  // safety net against a counter that is behind existing data.
  @Prop({ required: true, unique: true, trim: true, uppercase: true, immutable: true })
  code: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, required: true, enum: LocationType })
  type: LocationType;

  // parentId is the source of truth for the hierarchy; ancestors and depth
  // below are a cache derived from it, maintained only by LocationService.
  @Prop({ type: Types.ObjectId, ref: 'Location', default: null, index: true })
  parentId: Types.ObjectId | null;

  /** Ids from the root down to the direct parent; empty for a top-level location. */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Location' }], default: [], index: true })
  ancestors: Types.ObjectId[];

  /** 0 for a top-level location; always equals ancestors.length. */
  @Prop({ required: true, default: 0, min: 0 })
  depth: number;

  /**
   * Bumped by every hierarchy change on the location it attaches to, so two
   * concurrent transactions touching the same part of the tree (e.g. A moved
   * under B while B is moved under A) hit a write conflict and get retried,
   * instead of both committing and corrupting the tree. Never exposed.
   */
  @Prop({ default: 0, select: false })
  treeVersion: number;

  @Prop({ type: String, required: true, enum: LocationStatus, default: LocationStatus.ACTIVE })
  status: LocationStatus;
}

export const LocationSchema = SchemaFactory.createForClass(Location);
