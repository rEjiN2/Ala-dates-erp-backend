import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ProductGroupDocument = HydratedDocument<ProductGroup>;

@Schema({ timestamps: true, collection: 'product_groups' })
export class ProductGroup {
  // Generated on create and never changed afterwards; `immutable` makes
  // Mongoose drop any later assignment or $set. The unique index stays as a
  // safety net against a counter that is behind existing data.
  @Prop({ required: true, unique: true, trim: true, uppercase: true, immutable: true })
  code: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: Types.ObjectId, ref: 'ProductGroup', default: null, index: true })
  under: Types.ObjectId | null;
}

export const ProductGroupSchema = SchemaFactory.createForClass(ProductGroup);
