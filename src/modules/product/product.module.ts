import { Module } from '@nestjs/common';
import { ProductGroupModule } from './product-groups/product-group.module.js';

@Module({
  imports: [ProductGroupModule],
})
export class ProductModule {}
