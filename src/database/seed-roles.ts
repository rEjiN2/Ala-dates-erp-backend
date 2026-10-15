import type { Model } from 'mongoose';
import type { RoleDocument } from '../modules/roles/schemas/role.schema.js';
import { ADMIN_PERMISSIONS, ADMIN_ROLE_NAME } from '../modules/roles/permissions.js';

/**
 * Creates the admin role if missing and makes sure it holds every permission.
 * $addToSet means a re-run grants newly added permissions (e.g. dashboard:view)
 * to an existing admin role without stripping anything granted by hand.
 */
export async function ensureAdminRole(roleModel: Model<RoleDocument>): Promise<RoleDocument> {
  const role = await roleModel
    .findOneAndUpdate(
      { name: ADMIN_ROLE_NAME },
      {
        $setOnInsert: { name: ADMIN_ROLE_NAME, description: 'Full access to every module' },
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
