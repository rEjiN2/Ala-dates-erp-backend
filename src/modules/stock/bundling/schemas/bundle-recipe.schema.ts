import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { UserSnapshot, UserSnapshotSchema } from '../../../../common/schemas/user-snapshot.schema.js';

export type BundleRecipeDocument = HydratedDocument<BundleRecipe>;

@Schema({ _id: false })
export class RecipeComponent {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  /** Per one bundle. */
  @Prop({ required: true })
  qty: number;
}

export const RecipeComponentSchema = SchemaFactory.createForClass(RecipeComponent);

/** What one bundle product is made of. Changing it never touches past bundlings (they keep a snapshot). */
@Schema({ collection: 'bundle_recipes', versionKey: false })
export class BundleRecipe {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true, unique: true })
  bundleProductId: Types.ObjectId;

  @Prop({ type: [RecipeComponentSchema], required: true, default: [] })
  components: RecipeComponent[];

  /** Packing cost per bundle on top of the components. */
  @Prop({ required: true, default: 0 })
  extraCostPerUnit: number;

  /** Starts at 1; +1 on each change. */
  @Prop({ required: true, default: 1 })
  version: number;

  @Prop({ type: UserSnapshotSchema, default: null })
  updatedBy: UserSnapshot | null;

  @Prop({ type: Date, default: null })
  updatedAt: Date | null;
}

export const BundleRecipeSchema = SchemaFactory.createForClass(BundleRecipe);
