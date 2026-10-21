import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from './schemas/product.schema.js';
import { ProductGroup, ProductGroupSchema } from '../product-groups/schemas/product-group.schema.js';
import { Unit, UnitSchema } from '../units/schemas/unit.schema.js';
import { ProductService } from './product.service.js';
import { ProductController } from './product.controller.js';
import { ProductUsageRegistry } from './product-usage.registry.js';
import { SequenceModule } from '../../sequence/sequence.module.js';
import { FilesModule } from '../../files/files.module.js';
import { AuditModule } from '../../audit/audit.module.js';
import { CommentsModule } from '../../comments/comments.module.js';

/** Modules that reference products import this one and register with ProductUsageRegistry. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: ProductGroup.name, schema: ProductGroupSchema },
      { name: Unit.name, schema: UnitSchema },
    ]),
    SequenceModule,
    FilesModule,
    AuditModule,
    CommentsModule,
  ],
  controllers: [ProductController],
  providers: [ProductService, ProductUsageRegistry],
  exports: [ProductService, ProductUsageRegistry],
})
export class ProductsModule {}
