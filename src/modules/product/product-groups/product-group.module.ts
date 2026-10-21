import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductGroup, ProductGroupSchema } from './schemas/product-group.schema.js';
import { ProductGroupService } from './product-group.service.js';
import { ProductGroupController } from './product-group.controller.js';
import { Product, ProductSchema } from '../products/schemas/product.schema.js';
import { SequenceModule } from '../../sequence/sequence.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ProductGroup.name, schema: ProductGroupSchema },
      // Read-only here: a group with products can't be deleted.
      { name: Product.name, schema: ProductSchema },
    ]),
    SequenceModule,
  ],
  controllers: [ProductGroupController],
  providers: [ProductGroupService],
  exports: [ProductGroupService],
})
export class ProductGroupModule {}
