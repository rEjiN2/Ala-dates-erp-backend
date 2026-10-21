import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './schemas/user.schema.js';
import { UsersService } from './users.service.js';
import { UserManagementService } from './user-management.service.js';
import { UsersController } from './users.controller.js';
import { Role, RoleSchema } from '../roles/schemas/role.schema.js';
import { Location, LocationSchema } from '../location/schemas/location.schema.js';
import { UserUsageRegistry } from './user-usage.registry.js';
import { LedgerAccountModule } from '../accounting/ledger-accounts/ledger-account.module.js';
import { AuditModule } from '../audit/audit.module.js';

/** Locations are read directly, only to check and name a user's location. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: Location.name, schema: LocationSchema },
    ]),
    LedgerAccountModule,
    AuditModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, UserManagementService, UserUsageRegistry],
  exports: [UsersService, UserManagementService, UserUsageRegistry],
})
export class UsersModule {}
