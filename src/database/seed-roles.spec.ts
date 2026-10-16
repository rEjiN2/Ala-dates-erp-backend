import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { mongooseTestRoot } from '../../test/mongo-test-db.js';
import { ensureAdminRole } from './seed-roles.js';
import { Role, RoleDocument, RoleSchema } from '../modules/roles/schemas/role.schema.js';
import { ADMIN_PERMISSIONS, ADMIN_ROLE_NAME, Permission } from '../modules/roles/permissions.js';

describe('ensureAdminRole (seed)', () => {
  let moduleRef: TestingModule;
  let roleModel: Model<RoleDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseTestRoot('seed_roles'), MongooseModule.forFeature([{ name: Role.name, schema: RoleSchema }])],
    }).compile();
    roleModel = moduleRef.get(getModelToken(Role.name));
    await roleModel.init();
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await roleModel.deleteMany({}).exec();
  });

  it('creates the admin role with every permission, parties:manage included', async () => {
    const role = await ensureAdminRole(roleModel);
    expect([...role.permissions].sort()).toEqual([...ADMIN_PERMISSIONS].sort());
    expect(role.permissions).toContain(Permission.PARTIES_MANAGE);
  });

  it('adds missing permissions to an existing admin role, keeps hand-granted ones, and never duplicates', async () => {
    await roleModel.create({ name: ADMIN_ROLE_NAME, permissions: [Permission.ACCOUNTS_MANAGE, 'reports:export'] });

    await ensureAdminRole(roleModel);
    const role = await ensureAdminRole(roleModel);

    expect(role.permissions).toContain(Permission.PARTIES_MANAGE);
    expect(role.permissions).toContain('reports:export');
    expect(new Set(role.permissions).size).toBe(role.permissions.length);
    expect(await roleModel.countDocuments().exec()).toBe(1);
  });
});
