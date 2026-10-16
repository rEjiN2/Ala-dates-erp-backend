import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { mongooseTestRoot } from '../../../test/mongo-test-db.js';
import { UserManagementService } from './user-management.service.js';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';
import { CreateUserDto } from './dto/user.dto.js';
import { User, UserDocument, UserSchema, UserStatus } from './schemas/user.schema.js';
import { Role, RoleDocument, RoleSchema } from '../roles/schemas/role.schema.js';
import { Cashier, CashierDocument, CashierSchema } from '../cashier/schemas/cashier.schema.js';
import { LedgerAccountService } from '../accounting/ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../accounting/ledger-accounts/ledger-account-usage.registry.js';
import {
  LedgerAccount,
  LedgerAccountDocument,
  LedgerAccountSchema,
  LedgerAccountStatus,
  LedgerAccountType,
} from '../accounting/ledger-accounts/schemas/ledger-account.schema.js';
import { LocationService } from '../location/location.service.js';
import { Location, LocationSchema } from '../location/schemas/location.schema.js';
import { SequenceService } from '../sequence/sequence.service.js';
import { Counter, CounterSchema } from '../sequence/schemas/counter.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditLog, AuditLogDocument, AuditLogSchema } from '../audit/schemas/audit-log.schema.js';
import { JwtAuthGuard, PASSWORD_CHANGE_REQUIRED_MESSAGE } from '../../common/guards/jwt-auth.guard.js';
import { ALLOW_PENDING_PASSWORD_CHANGE_KEY } from '../../common/decorators/allow-pending-password-change.decorator.js';
import { JwtAccessStrategy } from '../auth/strategies/jwt-access.strategy.js';
import { AuthController } from '../auth/auth.controller.js';
import { createAppValidationPipe } from '../../common/pipes/app-validation.pipe.js';
import { ADMIN_ROLE_NAME, DataScope, Permission, VAN_SALESMAN_PERMISSIONS } from '../roles/permissions.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

describe('Users (UserManagementService)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let service: UserManagementService;
  let userModel: Model<UserDocument>;
  let roleModel: Model<RoleDocument>;
  let cashierModel: Model<CashierDocument>;
  let accountModel: Model<LedgerAccountDocument>;
  let auditModel: Model<AuditLogDocument>;
  let adminRole: RoleDocument;
  let salesRole: RoleDocument;
  let root: UserDocument;
  let rootActor: { id: string; name: string };
  let tokenUser: AuthenticatedUser;
  const pipe = createAppValidationPipe();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('users'),
        MongooseModule.forFeature([
          { name: User.name, schema: UserSchema },
          { name: Role.name, schema: RoleSchema },
          { name: Cashier.name, schema: CashierSchema },
          { name: LedgerAccount.name, schema: LedgerAccountSchema },
          { name: Location.name, schema: LocationSchema },
          { name: Counter.name, schema: CounterSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
        ]),
      ],
      controllers: [UsersController],
      providers: [
        UserManagementService,
        UsersService,
        LedgerAccountService,
        LedgerAccountUsageRegistry,
        LocationService,
        SequenceService,
        AuditService,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = tokenUser;
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();

    service = moduleRef.get(UserManagementService);
    userModel = moduleRef.get(getModelToken(User.name));
    roleModel = moduleRef.get(getModelToken(Role.name));
    cashierModel = moduleRef.get(getModelToken(Cashier.name));
    accountModel = moduleRef.get(getModelToken(LedgerAccount.name));
    auditModel = moduleRef.get(getModelToken(AuditLog.name));
    await Promise.all([userModel.init(), roleModel.init(), cashierModel.init(), auditModel.init()]);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    adminRole = await roleModel.create({
      name: ADMIN_ROLE_NAME,
      permissions: [Permission.USERS_MANAGE],
      dataScope: DataScope.ALL,
      isSystem: true,
    });
    salesRole = await roleModel.create({
      name: 'Van Salesman',
      permissions: [...VAN_SALESMAN_PERMISSIONS],
      dataScope: DataScope.OWN,
    });
    root = await userModel.create({ email: 'root@ala.ae', passwordHash: 'x', name: 'Root', role: adminRole._id });
    rootActor = { id: root.id as string, name: 'Root' };
    tokenUser = {
      id: root.id as string,
      email: 'root@ala.ae',
      name: 'Root',
      role: { id: adminRole.id as string, name: ADMIN_ROLE_NAME },
      permissions: [Permission.USERS_MANAGE],
    };
  });

  afterEach(async () => {
    await Promise.all([
      userModel.deleteMany({}).exec(),
      roleModel.deleteMany({}).exec(),
      cashierModel.deleteMany({}).exec(),
      accountModel.deleteMany({}).exec(),
      auditModel.collection.deleteMany({}),
    ]);
  });

  const account = (code: string, type: LedgerAccountType, status = LedgerAccountStatus.ACTIVE) =>
    accountModel.create({ code, name: `${code} account`, type, balance: 0, status });

  const newUser = (extra: Partial<CreateUserDto> = {}) =>
    service.create(
      { name: 'Rashid', email: 'rashid@ala.ae', password: 'van-pass-1', roleId: salesRole.id as string, ...extra },
      rootActor,
    );

  const actions = async (userId: string) =>
    (await auditModel.find({ entityId: new Types.ObjectId(userId) }).sort({ at: 1, _id: 1 }).lean().exec()).map(
      (entry) => entry.action,
    );

  describe('create', () => {
    it('hashes the password, forces a change at first login and audits', async () => {
      const cash = await account('CASH-0001', LedgerAccountType.CASH);
      const user = await newUser({ allowedCashAccountIds: [cash.id as string] });
      expect(user).toMatchObject({
        name: 'Rashid',
        email: 'rashid@ala.ae',
        status: 'active',
        mustChangePassword: true,
        role: { name: 'Van Salesman', dataScope: 'own' },
        allowedCashAccounts: [{ id: cash.id, code: 'CASH-0001', type: 'cash' }],
        linkedCashier: null,
      });
      const stored = await userModel.findById(user.id).select('+passwordHash').exec();
      expect(stored!.passwordHash).not.toBe('van-pass-1');
      expect(await bcrypt.compare('van-pass-1', stored!.passwordHash)).toBe(true);
      expect(await actions(user.id)).toEqual(['created']);
    });

    it('validates the password length, email uniqueness and allowed account types', async () => {
      await expect(
        pipe.transform(
          { name: 'A', email: 'a@ala.ae', password: 'short', roleId: salesRole.id },
          { type: 'body', metatype: CreateUserDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await newUser();
      await expect(newUser({ email: 'RASHID@ala.ae' })).rejects.toBeInstanceOf(ConflictException);

      const bank = await account('BNK-0001', LedgerAccountType.BANK);
      const closed = await account('CASH-0009', LedgerAccountType.CASH, LedgerAccountStatus.INACTIVE);
      await expect(newUser({ email: 'b@ala.ae', allowedCashAccountIds: [bank.id as string] })).rejects.toThrow(
        /Only cash and wallet accounts/,
      );
      await expect(newUser({ email: 'c@ala.ae', allowedCashAccountIds: [closed.id as string] })).rejects.toThrow(
        /inactive/,
      );
    });
  });

  describe('last admin guard', () => {
    it('blocks deactivating, demoting or deleting the last active admin', async () => {
      const other = await newUser({ email: 'boss@ala.ae', roleId: adminRole.id as string });
      // Two admins: one of them may go.
      await service.deactivate(other.id, rootActor);

      // Root is now the only active admin. A fresh actor tries to remove them.
      const actor = { id: new Types.ObjectId().toString(), name: 'Helper' };
      await expect(service.deactivate(root.id as string, actor)).rejects.toThrow(
        'Cannot deactivate, demote or delete the last active admin',
      );
      await expect(service.update(root.id as string, { roleId: salesRole.id as string }, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.remove(root.id as string, actor)).rejects.toBeInstanceOf(ConflictException);
      expect((await service.findOne(root.id as string)).role?.name).toBe(ADMIN_ROLE_NAME);

      // Reactivating the other admin lifts the block.
      await service.update(other.id, { status: UserStatus.ACTIVE }, rootActor);
      await expect(service.update(root.id as string, { roleId: salesRole.id as string }, actor)).resolves.toMatchObject({
        role: { name: 'Van Salesman' },
      });
    });

    it('treats a legacy isActive:false admin as inactive', async () => {
      await userModel.collection.insertOne({
        email: 'old@ala.ae',
        passwordHash: 'x',
        name: 'Old Admin',
        role: adminRole._id,
        isActive: false,
      });
      const actor = { id: new Types.ObjectId().toString(), name: 'Helper' };
      await expect(service.deactivate(root.id as string, actor)).rejects.toBeInstanceOf(ConflictException);
    });

    it('stops users deactivating or deleting themselves', async () => {
      await expect(service.deactivate(root.id as string, rootActor)).rejects.toThrow(/your own user/);
      await expect(service.remove(root.id as string, rootActor)).rejects.toThrow(/your own user/);
    });
  });

  describe('update, deactivate and delete', () => {
    it('audits readable changes and rejects a no-op', async () => {
      const cash = await account('CASH-0001', LedgerAccountType.CASH);
      const user = await newUser();
      await service.update(user.id, { name: 'Rashid Ali', allowedCashAccountIds: [cash.id as string] }, rootActor);
      await expect(service.update(user.id, { name: 'Rashid Ali' }, rootActor)).rejects.toThrow('No changes to save');
      await service.deactivate(user.id, rootActor);

      const history = await auditModel.find({ entityId: new Types.ObjectId(user.id) }).sort({ at: 1, _id: 1 }).lean();
      expect(history.map((entry) => entry.action)).toEqual(['created', 'updated', 'deactivated']);
      expect(history[1].changes).toEqual([
        { field: 'name', label: 'Name', from: 'Rashid', to: 'Rashid Ali' },
        { field: 'allowedCashAccounts', label: 'Allowed cash accounts', from: null, to: 'CASH-0001 (CASH-0001 account)' },
      ]);
      expect(history.every((entry) => entry.actorName === 'Root')).toBe(true);
    });

    it('deletes only a user with no history; otherwise asks to deactivate', async () => {
      const fresh = await newUser({ email: 'fresh@ala.ae' });
      await expect(service.remove(fresh.id, rootActor)).resolves.toEqual({ success: true });
      expect(await userModel.exists({ _id: fresh.id }).exec()).toBeNull();

      const linked = await newUser({ email: 'linked@ala.ae' });
      await cashierModel.create({ code: 'CSH-0001', name: 'Van 1', linkedUserId: new Types.ObjectId(linked.id) });
      expect((await service.findOne(linked.id)).linkedCashier).toMatchObject({ code: 'CSH-0001', name: 'Van 1' });
      await expect(service.remove(linked.id, rootActor)).rejects.toThrow(/linked to cashier CSH-0001/);

      const active = await newUser({ email: 'active@ala.ae' });
      await service.resetPassword(active.id, { password: 'another-1' }, { id: active.id, name: 'Rashid' });
      await expect(service.remove(active.id, rootActor)).rejects.toThrow(/recorded activity/);
    });
  });

  describe('passwords', () => {
    it('reset sets a temporary password and forces a change; the change clears it', async () => {
      const user = await newUser();
      await userModel.updateOne({ _id: user.id }, { mustChangePassword: false, refreshTokenHash: 'h' }).exec();

      await service.resetPassword(user.id, { password: 'temp-pass-9' }, rootActor);
      let stored = await userModel.findById(user.id).select('+passwordHash +refreshTokenHash').exec();
      expect(stored!.mustChangePassword).toBe(true);
      expect(stored!.refreshTokenHash).toBeUndefined();
      expect(await bcrypt.compare('temp-pass-9', stored!.passwordHash)).toBe(true);

      const self = { id: user.id, name: 'Rashid' };
      await expect(
        service.changeOwnPassword(self, { currentPassword: 'wrong-pass', newPassword: 'new-pass-1' }),
      ).rejects.toThrow('Current password is incorrect');
      await expect(
        service.changeOwnPassword(self, { currentPassword: 'temp-pass-9', newPassword: 'temp-pass-9' }),
      ).rejects.toThrow(/must be different/);
      await service.changeOwnPassword(self, { currentPassword: 'temp-pass-9', newPassword: 'new-pass-1' });
      stored = await userModel.findById(user.id).select('+passwordHash').exec();
      expect(stored!.mustChangePassword).toBe(false);
      expect(await bcrypt.compare('new-pass-1', stored!.passwordHash)).toBe(true);
      expect(await actions(user.id)).toEqual(['created', 'password-reset', 'password-changed']);
    });

    it('lets a user who must change their password reach only routes marked for it', () => {
      const reflector = new Reflector();
      const guard = new JwtAuthGuard(reflector);
      const marked = () => undefined;
      Reflect.defineMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true, marked);
      const contextFor = (handler: () => void) =>
        ({ getHandler: () => handler, getClass: () => class {} }) as unknown as ExecutionContext;
      const pending = { ...tokenUser, mustChangePassword: true };

      expect(() => guard.handleRequest(null, pending, null, contextFor(() => undefined))).toThrow(
        new ForbiddenException(PASSWORD_CHANGE_REQUIRED_MESSAGE),
      );
      expect(guard.handleRequest(null, pending, null, contextFor(marked))).toBe(pending);
      expect(guard.handleRequest(null, tokenUser, null, contextFor(() => undefined))).toBe(tokenUser);
      for (const method of ['me', 'changePassword', 'logout'] as const) {
        expect(Reflect.getMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, AuthController.prototype[method])).toBe(true);
      }
    });
  });

  describe('session checks (JwtAccessStrategy)', () => {
    const strategy = () =>
      new JwtAccessStrategy(
        { get: () => 'test-secret' } as never,
        moduleRef.get(UsersService),
      );
    const payload = (sub: string) => ({ sub, tokenType: 'access' as const, email: '', roleId: '', roleName: '', permissions: [] });

    it('rebuilds the user with role scope and allowed accounts, and blocks an inactive user on the next request', async () => {
      const cash = await account('CASH-0001', LedgerAccountType.CASH);
      const user = await newUser({ allowedCashAccountIds: [cash.id as string] });
      await expect(strategy().validate(payload(user.id))).resolves.toMatchObject({
        id: user.id,
        dataScope: 'own',
        allowedCashAccountIds: [cash.id],
        permissions: [...VAN_SALESMAN_PERMISSIONS],
        mustChangePassword: true,
      });

      await service.deactivate(user.id, rootActor);
      await expect(strategy().validate(payload(user.id))).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('HTTP', () => {
    it('needs users:manage for everything but the lookup', async () => {
      const server = app.getHttpServer();
      tokenUser = { ...tokenUser, permissions: [] };
      expect((await request(server).get('/users/lookup')).status).toBe(200);
      expect((await request(server).get('/users')).status).toBe(403);
      expect((await request(server).post(`/users/${root.id}/reset-password`).send({ password: 'abcdefgh' })).status).toBe(
        403,
      );

      tokenUser = { ...tokenUser, permissions: [Permission.USERS_MANAGE] };
      const list = await request(server).get('/users').query({ status: 'active' });
      expect(list.status).toBe(200);
      expect(list.body.items.map((user: { email: string }) => user.email)).toEqual(['root@ala.ae']);
      const created = await request(server)
        .post('/users')
        .send({ name: 'Rashid', email: 'rashid@ala.ae', password: 'van-pass-1', roleId: salesRole.id });
      expect(created.status).toBe(201);
      expect(created.body).not.toHaveProperty('passwordHash');
      expect((await request(server).post(`/users/${created.body.id}/deactivate`)).body.status).toBe('inactive');
    });
  });
});
