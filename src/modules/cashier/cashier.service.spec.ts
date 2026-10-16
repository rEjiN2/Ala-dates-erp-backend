import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import { mongooseTestRoot } from '../../../test/mongo-test-db.js';
import { CashierService } from './cashier.service.js';
import { CashierController } from './cashier.controller.js';
import { CashierUsageRegistry } from './cashier-usage.registry.js';
import { Cashier, CashierDocument, CashierSchema, CashierStatus } from './schemas/cashier.schema.js';
import { CashierLookupQueryDto, CreateCashierDto, UpdateCashierDto } from './dto/cashier.dto.js';
import { LocationService } from '../location/location.service.js';
import { Location, LocationDocument, LocationSchema, LocationType } from '../location/schemas/location.schema.js';
import { SequenceService } from '../sequence/sequence.service.js';
import { Counter, CounterDocument, CounterSchema } from '../sequence/schemas/counter.schema.js';
import { UsersService } from '../users/users.service.js';
import { User, UserDocument, UserSchema } from '../users/schemas/user.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditLog, AuditLogDocument, AuditLogSchema } from '../audit/schemas/audit-log.schema.js';
import { EntityAccessRegistry } from '../comments/entity-access.registry.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { createAppValidationPipe } from '../../common/pipes/app-validation.pipe.js';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator.js';
import { ADMIN_PERMISSIONS, Permission } from '../roles/permissions.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

describe('Cashier master (CashierService)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let service: CashierService;
  let usageRegistry: CashierUsageRegistry;
  let cashierModel: Model<CashierDocument>;
  let userModel: Model<UserDocument>;
  let locationModel: Model<LocationDocument>;
  let counterModel: Model<CounterDocument>;
  let auditService: AuditService;
  let auditModel: Model<AuditLogDocument>;

  const admin = { id: new Types.ObjectId().toString(), name: 'Admin' };
  let tokenUser: AuthenticatedUser;
  const pipe = createAppValidationPipe();

  /** Cashier ids that the fake "voucher" usage check reports as referenced. */
  const referenced = new Set<string>();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('cashiers'),
        MongooseModule.forFeature([
          { name: Cashier.name, schema: CashierSchema },
          { name: Location.name, schema: LocationSchema },
          { name: Counter.name, schema: CounterSchema },
          { name: User.name, schema: UserSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
        ]),
      ],
      controllers: [CashierController],
      providers: [
        CashierService,
        CashierUsageRegistry,
        LocationService,
        SequenceService,
        UsersService,
        AuditService,
        EntityAccessRegistry,
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

    service = moduleRef.get(CashierService);
    usageRegistry = moduleRef.get(CashierUsageRegistry);
    auditService = moduleRef.get(AuditService);
    cashierModel = moduleRef.get(getModelToken(Cashier.name));
    userModel = moduleRef.get(getModelToken(User.name));
    locationModel = moduleRef.get(getModelToken(Location.name));
    counterModel = moduleRef.get(getModelToken(Counter.name));
    auditModel = moduleRef.get(getModelToken(AuditLog.name));
    // Indexes must exist before the tests: the unique ones are the race backstop.
    await Promise.all([cashierModel.init(), userModel.init(), auditModel.init(), counterModel.init()]);

    usageRegistry.register('test vouchers', async (cashierId) => referenced.has(cashierId.toString()));
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  afterEach(async () => {
    referenced.clear();
    await cashierModel.deleteMany({}).exec();
    await userModel.deleteMany({}).exec();
    await locationModel.deleteMany({}).exec();
    await counterModel.deleteMany({}).exec();
    await auditModel.collection.deleteMany({});
  });

  async function makeUser(name: string): Promise<UserDocument> {
    return userModel.create({
      email: `${name.toLowerCase()}@example.com`,
      passwordHash: 'x',
      name,
      role: new Types.ObjectId(),
    });
  }

  const create = (dto: Partial<CreateCashierDto> & { name: string }) => service.create(dto, admin);
  const historyOf = async (cashier: CashierDocument) => auditService.findForEntity('cashier', cashier._id);

  describe('codes', () => {
    it('issues CSH-0001, CSH-0002, ... and never changes them', async () => {
      const first = await create({ name: 'Ali' });
      const second = await create({ name: 'Omar' });
      expect([first.code, second.code]).toEqual(['CSH-0001', 'CSH-0002']);

      // The API can't send one...
      await expect(
        pipe.transform({ name: 'X', code: 'CSH-9999' }, { type: 'body', metatype: CreateCashierDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        pipe.transform({ code: 'CSH-9999' }, { type: 'body', metatype: UpdateCashierDto }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // ...and the schema ignores a direct assignment.
      first.code = 'CSH-9999';
      await first.save();
      expect((await cashierModel.findById(first._id).exec())!.code).toBe('CSH-0001');
    });

    it('does not burn a code on a rejected create', async () => {
      await create({ name: 'Ali' });
      await expect(create({ name: 'ALI' })).rejects.toBeInstanceOf(ConflictException);
      expect((await create({ name: 'Omar' })).code).toBe('CSH-0002');
    });
  });

  describe('name uniqueness', () => {
    it('rejects a second active cashier with the same name, ignoring case and spaces', async () => {
      await create({ name: 'Ali Hassan' });

      const dto = (await pipe.transform(
        { name: '  ali hassan ' },
        { type: 'body', metatype: CreateCashierDto },
      )) as CreateCashierDto;
      expect(dto.name).toBe('ali hassan');
      await expect(service.create(dto, admin)).rejects.toThrow(/An active cashier named "Ali Hassan" already exists/);
      await expect(create({ name: 'ALI HASSAN' })).rejects.toBeInstanceOf(ConflictException);
      expect(await cashierModel.countDocuments().exec()).toBe(1);
    });

    it('frees the name once its cashier is inactive, and blocks reactivating a clash', async () => {
      const old = await create({ name: 'Ali' });
      await service.update(old.id, { status: CashierStatus.INACTIVE }, admin);

      const replacement = await create({ name: 'ali' });
      expect(replacement.status).toBe('active');
      // An inactive cashier may share the name...
      await expect(create({ name: 'Ali', status: CashierStatus.INACTIVE })).resolves.toBeDefined();
      // ...but can't come back while an active one holds it.
      await expect(service.update(old.id, { status: CashierStatus.ACTIVE }, admin)).rejects.toThrow(/already exists/);
    });

    it("rejects renaming onto an active cashier's name", async () => {
      await create({ name: 'Ali' });
      const omar = await create({ name: 'Omar' });
      await expect(service.update(omar.id, { name: 'ALI' }, admin)).rejects.toBeInstanceOf(ConflictException);
      // Changing only the case of its own name is fine.
      await expect(service.update(omar.id, { name: 'OMAR' }, admin)).resolves.toMatchObject({ name: 'OMAR' });
    });

    it('is enforced by the database even when the service check is bypassed', async () => {
      await create({ name: 'Ali' });
      await expect(
        cashierModel.create({ code: 'CSH-0099', name: 'ALI', status: CashierStatus.ACTIVE }),
      ).rejects.toMatchObject({ code: 11000 });
    });
  });

  describe('linked user', () => {
    it('links at most one cashier per user, and finds it for /me', async () => {
      const user = await makeUser('Sara');
      const sara = await create({ name: 'Sara', linkedUserId: user.id });

      await expect(create({ name: 'Sara 2', linkedUserId: user.id })).rejects.toThrow(
        /already linked to cashier CSH-0001/,
      );
      const other = await create({ name: 'Other' });
      await expect(service.update(other.id, { linkedUserId: user.id }, admin)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect((await service.findByLinkedUser(user.id))!.id).toBe(sara.id);
      expect(await service.findByLinkedUser(new Types.ObjectId().toString())).toBeNull();

      // Unlinking frees the user.
      await service.update(sara.id, { linkedUserId: null }, admin);
      await expect(service.update(other.id, { linkedUserId: user.id }, admin)).resolves.toBeDefined();
    });

    it('allows any number of cashiers with no linked user', async () => {
      await create({ name: 'A' });
      await create({ name: 'B' });
      expect(await cashierModel.countDocuments({ linkedUserId: null }).exec()).toBe(2);
    });

    it('rejects a user or location that does not exist', async () => {
      await expect(create({ name: 'A', linkedUserId: new Types.ObjectId().toString() })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(create({ name: 'A', locationId: new Types.ObjectId().toString() })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await cashierModel.countDocuments().exec()).toBe(0);
    });
  });

  describe('delete and deactivate', () => {
    it('deletes a cashier no voucher refers to', async () => {
      const cashier = await create({ name: 'Ali' });
      await expect(service.remove(cashier.id)).resolves.toEqual({ success: true });
      expect(await cashierModel.countDocuments().exec()).toBe(0);
    });

    it('refuses to delete a cashier a voucher refers to, but allows deactivating it', async () => {
      const cashier = await create({ name: 'Ali' });
      referenced.add(cashier.id);

      await expect(service.remove(cashier.id)).rejects.toThrow(
        'Cannot delete cashier CSH-0001 (Ali): it is used by test vouchers. Deactivate it instead.',
      );
      const deactivated = await service.update(cashier.id, { status: CashierStatus.INACTIVE }, admin);
      expect(deactivated.status).toBe('inactive');
      expect(await cashierModel.countDocuments().exec()).toBe(1);
    });

    it('refuses an inactive cashier for posting', async () => {
      const cashier = await create({ name: 'Ali', status: CashierStatus.INACTIVE });
      await expect(service.findActiveForPosting(cashier.id)).rejects.toThrow(/CSH-0001 \(Ali\) is inactive/);
    });
  });

  describe('audit', () => {
    it('records create, update and deactivate with readable changes', async () => {
      const user = await makeUser('Sara');
      const location = await locationModel.create({ code: 'ST-0001', name: 'Ajman Store', type: LocationType.STORE });
      const cashier = await create({ name: 'Ali', mobile: '+971 50 123 4567' });

      await service.update(
        cashier.id,
        { name: 'Ali Hassan', mobile: null, linkedUserId: user.id, locationId: location.id, notes: 'Night shift' },
        admin,
      );
      await service.update(cashier.id, { status: CashierStatus.INACTIVE }, admin);

      const history = await historyOf(cashier);
      expect(history.map((entry) => entry.action)).toEqual(['deactivated', 'updated', 'created']);
      expect(history.every((entry) => entry.actorName === 'Admin' && entry.entityRef === 'CSH-0001')).toBe(true);
      expect(history[1].changes).toEqual([
        { field: 'name', label: 'Name', from: 'Ali', to: 'Ali Hassan' },
        { field: 'mobile', label: 'Mobile', from: '+971 50 123 4567', to: null },
        { field: 'linkedUser', label: 'Linked user', from: null, to: 'Sara' },
        { field: 'location', label: 'Location', from: null, to: 'Ajman Store' },
        { field: 'notes', label: 'Notes', from: null, to: 'Night shift' },
      ]);
      expect(history[0].changes).toEqual([{ field: 'status', label: 'Status', from: 'active', to: 'inactive' }]);
    });

    it('rejects an update that changes nothing, without an audit entry', async () => {
      const cashier = await create({ name: 'Ali', mobile: '0501234567' });
      for (const dto of [{}, { name: 'Ali' }, { mobile: '0501234567', status: CashierStatus.ACTIVE }]) {
        await expect(service.update(cashier.id, dto, admin)).rejects.toThrow('No changes to save');
      }
      expect((await historyOf(cashier)).map((entry) => entry.action)).toEqual(['created']);
    });
  });

  describe('list and lookup', () => {
    it('searches, filters by status and paginates', async () => {
      await create({ name: 'Ali', email: 'ali@ala.ae' });
      await create({ name: 'Omar', mobile: '0559998888' });
      await create({ name: 'Zaid', status: CashierStatus.INACTIVE });

      expect((await service.list({ page: 1, limit: 20 })).total).toBe(3);
      expect((await service.list({ q: 'ALA.AE', page: 1, limit: 20 })).items.map((c) => c.name)).toEqual(['Ali']);
      expect((await service.list({ q: '9998', page: 1, limit: 20 })).items.map((c) => c.name)).toEqual(['Omar']);
      expect((await service.list({ q: 'csh-0003', page: 1, limit: 20 })).items.map((c) => c.name)).toEqual(['Zaid']);
      expect(
        (await service.list({ status: CashierStatus.ACTIVE, page: 1, limit: 20 })).items.map((c) => c.name),
      ).toEqual(['Ali', 'Omar']);

      const page2 = await service.list({ page: 2, limit: 2 });
      expect(page2).toMatchObject({ total: 3, page: 2, limit: 2 });
      expect(page2.items.map((c) => c.code)).toEqual(['CSH-0003']);
    });

    it('looks up active cashiers by default, all when activeOnly=false', async () => {
      await create({ name: 'Ali' });
      await create({ name: 'Zaid', status: CashierStatus.INACTIVE });

      const parse = async (query: object) =>
        (await pipe.transform(query, { type: 'query', metatype: CashierLookupQueryDto })) as CashierLookupQueryDto;

      expect((await parse({})).activeOnly).toBe(true);
      expect((await parse({ activeOnly: 'false' })).activeOnly).toBe(false);
      await expect(parse({ activeOnly: 'maybe' })).rejects.toBeInstanceOf(BadRequestException);

      expect(await service.lookup(await parse({}))).toEqual([
        { id: expect.any(String), code: 'CSH-0001', name: 'Ali' },
      ]);
      expect((await service.lookup(await parse({ activeOnly: 'false' }))).map((c) => c.name)).toEqual(['Ali', 'Zaid']);
      expect((await service.lookup(await parse({ q: 'zai', activeOnly: 'false' }))).map((c) => c.code)).toEqual([
        'CSH-0002',
      ]);
    });
  });

  describe('HTTP', () => {
    const asUser = (permissions: string[]) => {
      tokenUser = {
        id: new Types.ObjectId().toString(),
        email: 'u@example.com',
        name: 'U',
        role: { id: 'r', name: 'r' },
        permissions,
      };
    };

    it('returns JSON null from /cashiers/me when the user has no cashier, else the cashier', async () => {
      asUser([]);
      const none = await request(app.getHttpServer()).get('/cashiers/me');
      expect(none.status).toBe(200);
      expect(none.text).toBe('null');

      const user = await makeUser('Sara');
      await create({ name: 'Sara', linkedUserId: user.id });
      tokenUser = { ...tokenUser, id: user.id };
      const mine = await request(app.getHttpServer()).get('/cashiers/me');
      expect(mine.body).toMatchObject({ code: 'CSH-0001', name: 'Sara' });
    });

    it('lets any logged-in user read, but needs cashiers:manage to write', async () => {
      asUser([]);
      const server = app.getHttpServer();
      expect((await request(server).get('/cashiers')).status).toBe(200);
      expect((await request(server).get('/cashiers/lookup')).status).toBe(200);
      expect((await request(server).post('/cashiers').send({ name: 'A' })).status).toBe(403);

      asUser([Permission.CASHIERS_MANAGE]);
      const created = await request(server).post('/cashiers').send({ name: 'A' });
      expect(created.status).toBe(201);
      expect(created.body.code).toBe('CSH-0001');

      for (const method of ['create', 'update', 'remove'] as const) {
        expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, CashierController.prototype[method])).toEqual([
          Permission.CASHIERS_MANAGE,
        ]);
      }
      expect(ADMIN_PERMISSIONS).toContain(Permission.CASHIERS_MANAGE);
    });
  });
});
