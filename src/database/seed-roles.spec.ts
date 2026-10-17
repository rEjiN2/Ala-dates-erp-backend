import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { mongooseTestRoot } from '../../test/mongo-test-db.js';
import { backfillUserStatus, ensureAdminRole, ensureDefaultRoles, migrateLegacyPermissions } from './seed-roles.js';
import { Role, RoleDocument, RoleSchema } from '../modules/roles/schemas/role.schema.js';
import { User, UserDocument, UserSchema } from '../modules/users/schemas/user.schema.js';
import {
  ACCOUNTANT_ROLE_NAME,
  ADMIN_PERMISSIONS,
  ADMIN_ROLE_NAME,
  DataScope,
  Permission,
  VAN_SALESMAN_PERMISSIONS,
  VAN_SALESMAN_ROLE_NAME,
} from '../modules/roles/permissions.js';

describe('role seed', () => {
  let moduleRef: TestingModule;
  let roleModel: Model<RoleDocument>;
  let userModel: Model<UserDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('seed_roles'),
        MongooseModule.forFeature([
          { name: Role.name, schema: RoleSchema },
          { name: User.name, schema: UserSchema },
        ]),
      ],
    }).compile();
    roleModel = moduleRef.get(getModelToken(Role.name));
    userModel = moduleRef.get(getModelToken(User.name));
    await Promise.all([roleModel.init(), userModel.init()]);
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await roleModel.deleteMany({}).exec();
    await userModel.collection.deleteMany({});
  });

  const sorted = (values: readonly string[]) => [...values].sort();

  it('creates the admin role with every permission, scope all, protected', async () => {
    const role = await ensureAdminRole(roleModel);
    expect(sorted(role.permissions)).toEqual(sorted(ADMIN_PERMISSIONS));
    expect(role).toMatchObject({ dataScope: DataScope.ALL, isSystem: true });
  });

  it('adds missing permissions to an existing admin role, keeps hand-granted ones, and never duplicates', async () => {
    await roleModel.create({ name: ADMIN_ROLE_NAME, permissions: [Permission.ACCOUNTS_MANAGE, 'reports:export'] });

    await ensureAdminRole(roleModel);
    const role = await ensureAdminRole(roleModel);

    expect(role.permissions).toContain(Permission.USERS_MANAGE);
    expect(role.permissions).toContain('reports:export');
    expect(new Set(role.permissions).size).toBe(role.permissions.length);
    expect(role.isSystem).toBe(true);
    expect(await roleModel.countDocuments().exec()).toBe(1);
  });

  it('splits legacy manage permissions in every role, idempotently', async () => {
    await roleModel.create({ name: 'Cashier desk', permissions: ['cash-receipts:manage', Permission.PARTIES_MANAGE] });
    await roleModel.create({ name: 'Payables', permissions: ['cash-payments:manage'] });

    await migrateLegacyPermissions(roleModel);
    expect(await migrateLegacyPermissions(roleModel)).toBe(0);

    const desk = await roleModel.findOne({ name: 'Cashier desk' }).lean().exec();
    expect(sorted(desk!.permissions)).toEqual(
      sorted([
        Permission.PARTIES_MANAGE,
        Permission.CASH_RECEIPTS_READ,
        Permission.CASH_RECEIPTS_CREATE,
        Permission.CASH_RECEIPTS_EDIT,
        Permission.CASH_RECEIPTS_CANCEL,
      ]),
    );
    const payables = await roleModel.findOne({ name: 'Payables' }).lean().exec();
    expect(payables!.permissions).toHaveLength(4);
    expect(payables!.permissions).not.toContain('cash-payments:manage');
  });

  it('upserts admin, Accountant and Van Salesman once, leaving edited starter roles alone', async () => {
    await roleModel.create({ name: ADMIN_ROLE_NAME, permissions: ['cash-receipts:manage'] });
    await ensureDefaultRoles(roleModel);

    const accountant = await roleModel.findOne({ name: ACCOUNTANT_ROLE_NAME }).lean().exec();
    expect(accountant!.dataScope).toBe(DataScope.ALL);
    expect(accountant!.permissions).toEqual(
      expect.arrayContaining([Permission.CASH_RECEIPTS_CANCEL, Permission.CASH_PAYMENTS_CREATE, Permission.BALANCES_VIEW]),
    );
    for (const missing of [Permission.USERS_MANAGE, Permission.ROLES_MANAGE, Permission.COMPANY_MANAGE]) {
      expect(accountant!.permissions).not.toContain(missing);
    }

    const salesman = await roleModel.findOne({ name: VAN_SALESMAN_ROLE_NAME }).lean().exec();
    expect(salesman).toMatchObject({ dataScope: DataScope.OWN, isSystem: false });
    expect(sorted(salesman!.permissions)).toEqual(sorted([...VAN_SALESMAN_PERMISSIONS]));

    const admin = await roleModel.findOne({ name: ADMIN_ROLE_NAME }).lean().exec();
    expect(sorted(admin!.permissions)).toEqual(sorted(ADMIN_PERMISSIONS));

    // An administrator edits the Van Salesman role; a re-run keeps the edit.
    await roleModel.updateOne({ name: VAN_SALESMAN_ROLE_NAME }, { permissions: [Permission.CASH_RECEIPTS_READ] }).exec();
    await ensureDefaultRoles(roleModel);
    expect(await roleModel.countDocuments().exec()).toBe(3);
    expect((await roleModel.findOne({ name: VAN_SALESMAN_ROLE_NAME }).lean().exec())!.permissions).toEqual([
      Permission.CASH_RECEIPTS_READ,
    ]);
  });

  it('grants starter permissions added in a later release once, without restoring removed ones', async () => {
    // A Van Salesman role seeded before cash handovers existed.
    await roleModel.create({
      name: VAN_SALESMAN_ROLE_NAME,
      permissions: [Permission.CASH_RECEIPTS_READ],
      dataScope: DataScope.OWN,
      seededPermissions: [Permission.CASH_RECEIPTS_READ, Permission.CASH_RECEIPTS_CREATE],
    });
    await ensureDefaultRoles(roleModel);
    const salesman = await roleModel.findOne({ name: VAN_SALESMAN_ROLE_NAME }).lean().exec();
    // New: cash-handovers:read. Removed by an administrator earlier: cash-receipts:create stays removed.
    expect(sorted(salesman!.permissions)).toEqual(sorted([Permission.CASH_RECEIPTS_READ, Permission.CASH_HANDOVERS_READ]));

    await roleModel.updateOne({ name: VAN_SALESMAN_ROLE_NAME }, { permissions: [Permission.CASH_RECEIPTS_READ] }).exec();
    await ensureDefaultRoles(roleModel);
    expect((await roleModel.findOne({ name: VAN_SALESMAN_ROLE_NAME }).lean().exec())!.permissions).toEqual([
      Permission.CASH_RECEIPTS_READ,
    ]);
  });

  it('moves users from isActive to status, once', async () => {
    const role = new Types.ObjectId();
    await userModel.collection.insertMany([
      { email: 'a@ala.ae', passwordHash: 'x', name: 'A', role, isActive: true },
      { email: 'b@ala.ae', passwordHash: 'x', name: 'B', role, isActive: false },
      { email: 'c@ala.ae', passwordHash: 'x', name: 'C', role, status: 'inactive' },
    ]);

    expect(await backfillUserStatus(userModel)).toBe(2);
    expect(await backfillUserStatus(userModel)).toBe(0);

    const users = await userModel.collection.find({}, { sort: { email: 1 } }).toArray();
    expect(users.map((user) => [user.email, user.status, 'isActive' in user])).toEqual([
      ['a@ala.ae', 'active', false],
      ['b@ala.ae', 'inactive', false],
      ['c@ala.ae', 'inactive', false],
    ]);
  });
});
