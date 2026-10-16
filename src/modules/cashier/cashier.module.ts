import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Cashier, CashierSchema } from './schemas/cashier.schema.js';
import { CashierService } from './cashier.service.js';
import { CashierController } from './cashier.controller.js';
import { CashierUsageRegistry } from './cashier-usage.registry.js';
import { SequenceModule } from '../sequence/sequence.module.js';
import { LocationModule } from '../location/location.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CommentsModule } from '../comments/comments.module.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Cashier.name, schema: CashierSchema }]),
    SequenceModule,
    LocationModule,
    UsersModule,
    AuditModule,
    CommentsModule,
  ],
  controllers: [CashierController],
  providers: [CashierService, CashierUsageRegistry],
  exports: [CashierService, CashierUsageRegistry],
})
export class CashierModule {}
