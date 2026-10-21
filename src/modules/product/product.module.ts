import { Module } from '@nestjs/common';
import { ProductGroupModule } from './product-groups/product-group.module.js';
import { UnitModule } from './units/unit.module.js';
import { ProductsModule } from './products/products.module.js';

@Module({
  imports: [ProductGroupModule, UnitModule, ProductsModule],
})
export class ProductModule {}
