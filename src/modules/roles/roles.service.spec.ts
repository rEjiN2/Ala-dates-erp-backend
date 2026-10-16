import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { mongooseTestRoot } from '../../../test/mongo-test-db.js';
import { RolesService } from './roles.service.js';
import { RolesController } from './roles.controller.js';
import { CreateRoleDto } from './dto/role.dto.js';
import { Role, RoleDocument, RoleSchema } from './schemas/role.schema.js';
import { User, UserDocument, UserSchema } from '../users/schemas/user.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditLog, AuditLogDocument, AuditLogSchema } from '../audit/schemas/audit-log.schema.js';
import { createAppValidationPipe } from '../../common/pipes/app-validation.pipe.js';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator.js';
import { ADMIN_ROLE_NAME, DataScope, Permission } from './permissions.js';

describe('Roles (RolesService)', () => {
  let moduleRef: TestingModule;
  let service: RolesService;
  let roleModel: Model<RoleDocument>;
  let userModel: Model<UserDocument>;
  let auditModel: Model<AuditLogDocument>;
  const admin = { id: new Types.ObjectId().toString(), name: 'Admin' };
  const pipe = createAppValidationPipe();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('roles'),
        MongooseModule.forFeature([
          { name: Role.name, schema: RoleSchema },
          { name: User.name, schema: UserSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
        ]),
      ],
      providers: [RolesService, AuditService],
    }).compile();
    service = moduleRef.get(RolesService);
    roleModel = moduleRef.get(getModelToken(Role.name));
    userModel = moduleRef.get(getModelToken(User.name));
    auditModel = moduleRef.get(getModelToken(AuditLog.name));
    await Promise.all([roleModel.init(), userModel.init(), auditModel.init()]);
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await Promise.all([
      roleModel.deleteMany({}).exec(),
      userModel.deleteMany({}).exec(),
      auditModel.collection.deleteMany({}),
    ]);
  });

  const create = (name: string, permissions: Permission[] = [Permission.CASH_RECEIPTS_READ]) =>
    service.create({ name, permissions, dataScope: DataScope.OWN }, admin);

  it('accepts only known permissions and a valid scope', async () => {
    for (const body of [
      { name: 'X', permissions: ['cash-receipts:manage'], dataScope: 'own' },
      { name: 'X', permissions: [], dataScope: 'mine' },
    ]) {
      await expect(pipe.transform(body, { type: 'body', metatype: CreateRoleDto })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it('creates, edits and audits a role; names are unique ignoring case', async () => {
    const role = await create('Store Keeper');
    expect(role).toMatchObject({ dataScope: 'own', isSystem: false, userCount: 0 });
    await expect(create('store keeper')).rejects.toBeInstanceOf(ConflictException);

    await service.update(role.id, { permissions: [Permission.CASH_RECEIPTS_READ, Permission.BALANCES_VIEW] }, admin);
    await expect(service.update(role.id, { dataScope: DataScope.OWN }, admin)).rejects.toThrow('No changes to save');

    const history = await auditModel.find({ entityId: new Types.ObjectId(role.id) }).sort({ at: 1, _id: 1 }).lean();
    expect(history.map((entry) => entry.action)).toEqual(['created', 'updated']);
    expect(history[1].changes).toEqual([
      {
        field: 'permissions',
        label: 'Permissions',
        from: 'cash-receipts:read',
        to: 'balances:view, cash-receipts:read',
      },
    ]);
  });

  it('protects the system admin role and roles still in use', async () => {
    const system = await roleModel.create({ name: ADMIN_ROLE_NAME, permissions: [], isSystem: true });
    await expect(service.update(system.id as string, { name: 'boss' }, admin)).rejects.toThrow(/managed by the system/);
    await expect(service.remove(system.id as string, admin)).rejects.toThrow(/managed by the system/);

    const role = await create('Driver');
    await userModel.create({ email: 'd@ala.ae', passwordHash: 'x', name: 'D', role: new Types.ObjectId(role.id) });
    await expect(service.remove(role.id, admin)).rejects.toThrow(/1 user\(s\) have it/);
    expect((await service.list()).find((listed) => listed.id === role.id)?.userCount).toBe(1);

    await userModel.deleteMany({}).exec();
    await expect(service.remove(role.id, admin)).resolves.toEqual({ success: true });
    expect((await auditModel.find({ entityId: new Types.ObjectId(role.id) }).lean()).map((e) => e.action)).toContain(
      'deleted',
    );
  });

  it('guards every route with roles:manage, and the lookup with users:manage', () => {
    const expected = [
      ...(['list', 'permissions', 'findOne', 'create', 'update', 'remove'] as const).map(
        (method) => [method, Permission.ROLES_MANAGE] as const,
      ),
      ['lookup', Permission.USERS_MANAGE] as const,
    ];
    for (const [method, permission] of expected) {
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, RolesController.prototype[method])).toEqual([permission]);
    }
  });
});
