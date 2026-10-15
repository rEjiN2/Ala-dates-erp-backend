import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { validateEnv, type EnvConfig } from './config/env.validation.js';
import { trackConnection } from './database/connection-status.js';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { RolesModule } from './modules/roles/roles.module.js';
import { PartyModule } from './modules/party/party.module.js';
import { SupplierModule } from './modules/supplier/supplier.module.js';
import { ProductModule } from './modules/product/product.module.js';
import { LocationModule } from './modules/location/location.module.js';
import { PurchaseModule } from './modules/purchase/purchase.module.js';
import { SalesModule } from './modules/sales/sales.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { AccountingModule } from './modules/accounting/accounting.module.js';
import { StorageModule } from './modules/storage/storage.module.js';
import { FilesModule } from './modules/files/files.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig, true>) => ({
        uri: configService.get('MONGODB_URI', { infer: true }),
        // Boot without waiting for MongoDB: if it is unreachable, the app still
        // starts and GET /health reports why, instead of the process exiting
        // and the host showing a bare 500. Queries wait for the connection.
        lazyConnection: true,
        connectionFactory: trackConnection,
        // Fail a bad connection in seconds, not the driver's 30s default.
        serverSelectionTimeoutMS: 10_000,
      }),
    }),
    HealthModule,
    AuthModule,
    UsersModule,
    RolesModule,
    PartyModule,
    SupplierModule,
    ProductModule,
    LocationModule,
    PurchaseModule,
    SalesModule,
    InventoryModule,
    AccountingModule,
    StorageModule,
    FilesModule,
    DashboardModule,
  ],
})
export class AppModule {}
