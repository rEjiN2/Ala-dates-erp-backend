import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Unit, UnitSchema } from './schemas/unit.schema.js';
import { Product, ProductSchema } from '../products/schemas/product.schema.js';
import { UnitService } from './unit.service.js';
import { UnitController } from './unit.controller.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Unit.name, schema: UnitSchema },
      // Read-only here: a unit used by a product can't be deleted.
      { name: Product.name, schema: ProductSchema },
    ]),
  ],
  controllers: [UnitController],
  providers: [UnitService],
  exports: [UnitService],
})
export class UnitModule {}
