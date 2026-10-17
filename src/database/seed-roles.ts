import type { Model } from 'mongoose';
import type { RoleDocument } from '../modules/roles/schemas/role.schema.js';
import { UserStatus, type UserDocument } from '../modules/users/schemas/user.schema.js';
import {
  ACCOUNTANT_PERMISSIONS,
  ACCOUNTANT_ROLE_NAME,
  ADMIN_PERMISSIONS,
  ADMIN_ROLE_NAME,
  DataScope,
  LEGACY_PERMISSION_REPLACEMENTS,
  VAN_SALESMAN_PERMISSIONS,
  VAN_SALESMAN_ROLE_NAME,
  type Permission,
} from '../modules/roles/permissions.js';

/**
 * Replaces split permissions (e.g. cash-receipts:manage) with their parts in
 * every role that still holds them. Safe to re-run: a role without a legacy
 * permission is untouched.
 */
export async function migrateLegacyPermissions(roleModel: Model<RoleDocument>): Promise<number> {
  let migrated = 0;
  for (const [legacy, replacements] of Object.entries(LEGACY_PERMISSION_REPLACEMENTS)) {
    const added = await roleModel
      .updateMany({ permissions: legacy }, { $addToSet: { permissions: { $each: [...replacements] } } })
      .exec();
    await roleModel.updateMany({ permissions: legacy }, { $pull: { permissions: legacy } }).exec();
    migrated += added.modifiedCount;
  }
  return migrated;
}

/**
 * Creates the admin role if missing and makes sure it holds every permission,
 * sees all data and is protected (isSystem). $addToSet means a re-run grants
 * newly added permissions to an existing admin role without stripping
 * anything granted by hand.
 */
export async function ensureAdminRole(roleModel: Model<RoleDocument>): Promise<RoleDocument> {
  const role = await roleModel
    .findOneAndUpdate(
      { name: ADMIN_ROLE_NAME },
      {
        $setOnInsert: { name: ADMIN_ROLE_NAME, description: 'Full access to every module' },
        $set: { dataScope: DataScope.ALL, isSystem: true },
        $addToSet: { permissions: { $each: [...ADMIN_PERMISSIONS] } },
      },
      { upsert: true, returnDocument: 'after' },
    )
    .exec();

  if (!role) {
    throw new Error(`Failed to create or load the "${ADMIN_ROLE_NAME}" role`);
  }
  return role;
}

/**
 * Creates a starter role if missing. On an existing one, grants only starter
 * permissions the seed has never granted it before (see Role.seededPermissions):
 * new permissions arrive once, ones an administrator removed stay removed,
 * and its scope and description are left alone.
 */
async function ensureStarterRole(
  roleModel: Model<RoleDocument>,
  name: string,
  description: string,
  permissions: readonly Permission[],
  dataScope: DataScope,
): Promise<RoleDocument> {
  await roleModel
    .updateOne(
      { name },
      { $setOnInsert: { name, description, permissions: [], dataScope, isSystem: false, seededPermissions: [] } },
      { upsert: true },
    )
    .exec();
  const existing = await roleModel.findOne({ name }).select('+seededPermissions').lean().exec();
  const alreadySeeded = new Set(existing?.seededPermissions ?? []);
  const fresh = permissions.filter((permission) => !alreadySeeded.has(permission));
  if (fresh.length > 0) {
    await roleModel
      .updateOne(
        { name },
        { $addToSet: { permissions: { $each: fresh }, seededPermissions: { $each: fresh } } },
      )
      .exec();
  }
  const role = await roleModel.findOne({ name }).exec();
  if (!role) {
    throw new Error(`Failed to create or load the "${name}" role`);
  }
  return role;
}

/** Admin, Accountant and Van Salesman, after migrating legacy permissions. Idempotent. */
export async function ensureDefaultRoles(roleModel: Model<RoleDocument>): Promise<RoleDocument[]> {
  await migrateLegacyPermissions(roleModel);
  return [
    await ensureAdminRole(roleModel),
    await ensureStarterRole(
      roleModel,
      ACCOUNTANT_ROLE_NAME,
      'Every voucher and master; no user, role or company management',
      ACCOUNTANT_PERMISSIONS,
      DataScope.ALL,
    ),
    await ensureStarterRole(
      roleModel,
      VAN_SALESMAN_ROLE_NAME,
      'Enters cash receipts for their own cashier; sees only their own receipts and no balances',
      VAN_SALESMAN_PERMISSIONS,
      DataScope.OWN,
    ),
  ];
}

/**
 * Moves users from the old isActive flag to status, then drops the flag.
 * Safe to re-run: users without isActive are untouched.
 */
export async function backfillUserStatus(userModel: Model<UserDocument>): Promise<number> {
  const inactive = await userModel
    .updateMany({ isActive: false }, { $set: { status: UserStatus.INACTIVE }, $unset: { isActive: 1 } })
    .exec();
  const active = await userModel
    .updateMany(
      { isActive: { $exists: true } },
      { $set: { status: UserStatus.ACTIVE }, $unset: { isActive: 1 } },
    )
    .exec();
  return inactive.modifiedCount + active.modifiedCount;
}
