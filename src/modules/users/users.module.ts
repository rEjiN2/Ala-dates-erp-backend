import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './schemas/user.schema.js';
import { UsersService } from './users.service.js';
import { UserManagementService } from './user-management.service.js';
import { UsersController } from './users.controller.js';
import { Role, RoleSchema } from '../roles/schemas/role.schema.js';
import { Cashier, CashierSchema } from '../cashier/schemas/cashier.schema.js';
import { LedgerAccountModule } from '../accounting/ledger-accounts/ledger-account.module.js';
import { AuditModule } from '../audit/audit.module.js';

/**
 * Cashier is read directly (the linked cashier lives on Cashier.linkedUserId):
 * CashierModule imports this module, so importing it back would be a cycle.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: Cashier.name, schema: CashierSchema },
    ]),
    LedgerAccountModule,
    AuditModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, UserManagementService],
  exports: [UsersService, UserManagementService],
})
export class UsersModule {}
