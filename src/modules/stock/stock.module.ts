import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StockEntry, StockEntrySchema } from './schemas/stock-entry.schema.js';
import { StockBalance, StockBalanceSchema } from './schemas/stock-balance.schema.js';
import { OpeningStock, OpeningStockSchema } from './opening-stock/schemas/opening-stock.schema.js';
import { Product, ProductSchema } from '../product/products/schemas/product.schema.js';
import { Unit, UnitSchema } from '../product/units/schemas/unit.schema.js';
import { ProductGroup, ProductGroupSchema } from '../product/product-groups/schemas/product-group.schema.js';
import { Location, LocationSchema } from '../location/schemas/location.schema.js';
import { StockService } from './stock.service.js';
import { StockController } from './stock.controller.js';
import { OpeningStockService } from './opening-stock/opening-stock.service.js';
import { OpeningStockController } from './opening-stock/opening-stock.controller.js';
import { ProductsModule } from '../product/products/products.module.js';
import { CompanyModule } from '../company/company.module.js';
import { SequenceModule } from '../sequence/sequence.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CommentsModule } from '../comments/comments.module.js';

/** The stock engine (StockService.post) and the stock vouchers built on it. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: StockEntry.name, schema: StockEntrySchema },
      { name: StockBalance.name, schema: StockBalanceSchema },
      { name: OpeningStock.name, schema: OpeningStockSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Unit.name, schema: UnitSchema },
      { name: ProductGroup.name, schema: ProductGroupSchema },
      { name: Location.name, schema: LocationSchema },
    ]),
    ProductsModule,
    CompanyModule,
    SequenceModule,
    AuditModule,
    CommentsModule,
  ],
  controllers: [StockController, OpeningStockController],
  providers: [StockService, OpeningStockService],
  exports: [StockService],
})
export class StockModule {}
