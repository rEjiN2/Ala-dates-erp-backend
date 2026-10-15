import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductGroup, ProductGroupSchema } from './schemas/product-group.schema.js';
import { ProductGroupService } from './product-group.service.js';
import { ProductGroupController } from './product-group.controller.js';
import { SequenceModule } from '../../sequence/sequence.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ProductGroup.name, schema: ProductGroupSchema }]),
    SequenceModule,
  ],
  controllers: [ProductGroupController],
  providers: [ProductGroupService],
  exports: [ProductGroupService],
})
export class ProductGroupModule {}
