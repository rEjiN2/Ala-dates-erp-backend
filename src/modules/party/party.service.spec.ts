import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import { mongooseTestRoot } from '../../../test/mongo-test-db.js';
import { PartyService } from './party.service.js';
import { PartyController } from './party.controller.js';
import { Party, PartyDocument, PartyKind, PartySchema, PartyStatus } from './schemas/party.schema.js';
import { CreatePartyDto, UpdatePartyDto } from './dto/party.dto.js';
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
import { Counter, CounterDocument, CounterSchema } from '../sequence/schemas/counter.schema.js';
import { FilesService } from '../files/files.service.js';
import { FileOwnerType } from '../files/schemas/file-attachment.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditLog, AuditLogDocument, AuditLogSchema } from '../audit/schemas/audit-log.schema.js';
import { EntityAccessRegistry } from '../comments/entity-access.registry.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { createAppValidationPipe } from '../../common/pipes/app-validation.pipe.js';
import { ADMIN_PERMISSIONS, Permission } from '../roles/permissions.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

const { CUSTOMER, SUPPLIER } = PartyKind;

/** Stand-in for the /files module: records calls, never touches storage. */
const filesService = {
  upload: vi.fn(async (file: Express.Multer.File | undefined, dto: { ownerType: FileOwnerType; ownerId: string }) => {
    if (!file) throw new BadRequestException('A file is required under the "file" field');
    const id = new Types.ObjectId().toString();
    return {
      id,
      url: `/files/${id}`,
      ownerType: dto.ownerType,
      ownerId: dto.ownerId,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    };
  }),
  remove: vi.fn(async () => ({ success: true as const })),
};

describe('Parties (PartyService)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let service: PartyService;
  let ledgerService: LedgerAccountService;
  let auditService: AuditService;
  let entityAccess: EntityAccessRegistry;
  let partyModel: Model<PartyDocument>;
  let ledgerModel: Model<LedgerAccountDocument>;
  let counterModel: Model<CounterDocument>;
  let auditModel: Model<AuditLogDocument>;

  const admin = { id: new Types.ObjectId().toString(), name: 'Admin' };
  let tokenUser: AuthenticatedUser;
  const pipe = createAppValidationPipe();
  /** Ledger account ids the fake "voucher" usage check reports as referenced. */
  const usedAccounts = new Set<string>();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('parties'),
        MongooseModule.forFeature([
          { name: Party.name, schema: PartySchema },
          { name: LedgerAccount.name, schema: LedgerAccountSchema },
          { name: Location.name, schema: LocationSchema },
          { name: Counter.name, schema: CounterSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
        ]),
      ],
      controllers: [PartyController],
      providers: [
        PartyService,
        LedgerAccountService,
        LedgerAccountUsageRegistry,
        LocationService,
        SequenceService,
        AuditService,
        EntityAccessRegistry,
        { provide: FilesService, useValue: filesService },
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

    service = moduleRef.get(PartyService);
    ledgerService = moduleRef.get(LedgerAccountService);
    auditService = moduleRef.get(AuditService);
    entityAccess = moduleRef.get(EntityAccessRegistry);
    partyModel = moduleRef.get(getModelToken(Party.name));
    ledgerModel = moduleRef.get(getModelToken(LedgerAccount.name));
    counterModel = moduleRef.get(getModelToken(Counter.name));
    auditModel = moduleRef.get(getModelToken(AuditLog.name));
    await Promise.all([partyModel.init(), ledgerModel.init(), counterModel.init(), auditModel.init()]);

    moduleRef
      .get(LedgerAccountUsageRegistry)
      .register('test vouchers', async (accountId) => usedAccounts.has(accountId.toString()));
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    filesService.upload.mockClear();
    filesService.remove.mockClear();
    usedAccounts.clear();
    await partyModel.deleteMany({}).exec();
    await ledgerModel.deleteMany({}).exec();
    await counterModel.deleteMany({}).exec();
    await auditModel.collection.deleteMany({});
  });

  const parse = async <T extends object>(body: object, metatype: new () => T) =>
    (await pipe.transform(body, { type: 'body', metatype })) as T;

  const create = (dto: Partial<CreatePartyDto> & { name: string }, kind: PartyKind = CUSTOMER) =>
    service.create({ kind, ...dto }, admin);

  const ledgerOf = async (party: { ledgerAccountId: string }) =>
    (await ledgerModel.findById(party.ledgerAccountId).exec())!;

  const historyOf = (party: { id: string }) => auditService.findForEntity('party', new Types.ObjectId(party.id));

  describe('create', () => {
    it('creates the party and its ledger account together', async () => {
      const customer = await create({ name: 'Ali Traders', vatNumber: '100234567800003' });
      const supplier = await create({ name: 'Omar Farms' }, SUPPLIER);

      expect(customer).toMatchObject({
        code: 'CUS-0001',
        kind: 'customer',
        status: 'active',
        vatNumber: '100234567800003',
      });
      expect(await ledgerOf(customer)).toMatchObject({
        code: 'CUS-0001',
        name: 'Ali Traders',
        type: LedgerAccountType.PARTY,
        balance: 0,
        status: LedgerAccountStatus.ACTIVE,
      });
      expect(await ledgerOf(supplier)).toMatchObject({
        code: 'SUP-0001',
        type: LedgerAccountType.SUPPLIER,
        balance: 0,
      });

      const [entry] = await historyOf(customer);
      expect(entry).toMatchObject({ action: 'created', actorName: 'Admin', entityRef: 'CUS-0001' });
    });

    it('keeps a separate code counter per kind', async () => {
      const codes = [];
      for (const kind of [CUSTOMER, SUPPLIER, CUSTOMER, CUSTOMER, SUPPLIER]) {
        codes.push((await create({ name: `P${codes.length}` }, kind)).code);
      }
      expect(codes).toEqual(['CUS-0001', 'SUP-0001', 'CUS-0002', 'CUS-0003', 'SUP-0002']);
    });

    it('takes no code, balance or opening balance from the client', async () => {
      for (const extra of [
        { code: 'CUS-9999' },
        { balance: 100 },
        { openingBalance: 100 },
        { ledgerAccountId: new Types.ObjectId().toString() },
      ]) {
        await expect(parse({ kind: CUSTOMER, name: 'A', ...extra }, CreatePartyDto)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
    });

    it('rolls back the party when creating the ledger account fails, and uses no code', async () => {
      vi.spyOn(ledgerService, 'createSystemAccount').mockRejectedValueOnce(new Error('ledger down'));

      await expect(create({ name: 'Ali Traders' })).rejects.toThrow('ledger down');
      expect(await partyModel.countDocuments().exec()).toBe(0);
      expect(await ledgerModel.countDocuments().exec()).toBe(0);
      expect((await create({ name: 'Ali Traders' })).code).toBe('CUS-0001');
    });

    it('rolls back the ledger account when saving the party fails', async () => {
      // A party field the schema rejects: the ledger account is already inserted by then.
      await expect(create({ name: 'Ali Traders', creditLimit: -5 })).rejects.toThrow(/creditLimit/);
      expect(await partyModel.countDocuments().exec()).toBe(0);
      expect(await ledgerModel.countDocuments().exec()).toBe(0);
    });

    it('rolls back party, ledger account and audit entry together when the audit write fails', async () => {
      const record = auditService.record.bind(auditService);
      vi.spyOn(auditService, 'record').mockImplementationOnce(async (entry, session) => {
        await record(entry, session);
        throw new Error('disk full');
      });

      await expect(create({ name: 'Ali Traders' })).rejects.toThrow('disk full');
      expect(await partyModel.countDocuments().exec()).toBe(0);
      expect(await ledgerModel.countDocuments().exec()).toBe(0);
      expect(await auditModel.countDocuments().exec()).toBe(0);
    });

    it('allows shipping addresses on customers only', async () => {
      const address = { label: 'Warehouse', address1: 'Jurf 3', city: 'Ajman', telephone: '+971 6 555 0000' };
      const customer = await create({ name: 'Ali', shippingAddresses: [address] });
      expect(customer.shippingAddresses).toEqual([
        expect.objectContaining({ id: expect.any(String), label: 'Warehouse', city: 'Ajman' }),
      ]);

      await expect(create({ name: 'Omar', shippingAddresses: [address] }, SUPPLIER)).rejects.toThrow(
        'Shipping addresses are only allowed on customers',
      );
      const supplier = await create({ name: 'Omar' }, SUPPLIER);
      await expect(service.update(supplier.id, { shippingAddresses: [address] }, admin)).rejects.toThrow(
        /only allowed on customers/,
      );
    });
  });

  describe('TRN and duplicates', () => {
    it('accepts a loosely written 15-digit TRN and rejects anything else', async () => {
      const dto = await parse({ kind: CUSTOMER, name: 'A', vatNumber: '100-2345-6780-0003' }, CreatePartyDto);
      expect(dto.vatNumber).toBe('100234567800003');
      expect((await parse({ kind: CUSTOMER, name: 'A', vatNumber: ' ' }, CreatePartyDto)).vatNumber).toBeNull();

      for (const vatNumber of ['10023456780000', '1002345678000031', 'TRN100234567800', 'abc']) {
        await expect(parse({ kind: CUSTOMER, name: 'A', vatNumber }, CreatePartyDto)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
    });

    it('rejects a second active party of the same kind with the same TRN', async () => {
      await create({ name: 'Ali Traders', vatNumber: '100234567800003' });

      await expect(create({ name: 'Ali Trading', vatNumber: '100234567800003' })).rejects.toThrow(
        'TRN 100234567800003 is already used by active customer CUS-0001 (Ali Traders)',
      );
      // A supplier may share it: duplicates are checked per kind.
      await expect(create({ name: 'Ali Traders', vatNumber: '100234567800003' }, SUPPLIER)).resolves.toBeDefined();
      expect(await partyModel.countDocuments({ kind: CUSTOMER }).exec()).toBe(1);
    });

    it('rejects a second active party of the same kind with the same name, ignoring case', async () => {
      await create({ name: 'Ali Traders' });

      await expect(create({ name: 'ALI TRADERS' })).rejects.toThrow(
        'An active customer named "Ali Traders" already exists (CUS-0001)',
      );
      const other = await create({ name: 'Omar' });
      await expect(service.update(other.id, { name: 'ali traders' }, admin)).rejects.toBeInstanceOf(ConflictException);
    });

    it('frees the TRN when the holder is deactivated', async () => {
      const old = await create({ name: 'Ali Traders', vatNumber: '100234567800003' });
      await service.update(old.id, { status: PartyStatus.INACTIVE }, admin);

      await expect(create({ name: 'Ali Traders New', vatNumber: '100234567800003' })).resolves.toBeDefined();
      // ...and the old one can't come back while the new one holds it.
      await expect(service.update(old.id, { status: PartyStatus.ACTIVE }, admin)).rejects.toThrow(/TRN/);
    });

    it('explains when an inactive party still holds the name in the ledger', async () => {
      const old = await create({ name: 'Ali Traders' });
      await service.update(old.id, { status: PartyStatus.INACTIVE }, admin);

      await expect(create({ name: 'ali traders' })).rejects.toThrow(
        /already used by inactive party ledger account CUS-0001 \("Ali Traders"\)/,
      );
    });

    it('is enforced by the database even when the service check is bypassed', async () => {
      const first = await create({ name: 'Ali', vatNumber: '100234567800003' });
      const clone = { kind: CUSTOMER, status: PartyStatus.ACTIVE, ledgerAccountId: new Types.ObjectId() };
      await expect(partyModel.create({ ...clone, code: 'CUS-0098', name: 'ALI' })).rejects.toMatchObject({
        code: 11000,
      });
      await expect(
        partyModel.create({ ...clone, code: 'CUS-0099', name: 'Other', vatNumber: first.vatNumber }),
      ).rejects.toMatchObject({ code: 11000 });
    });
  });

  describe('update', () => {
    it('renames the ledger account with the party, and records a field diff', async () => {
      const party = await create({ name: 'Ali Traders', city: 'Ajman' });

      const updated = await service.update(
        party.id,
        { name: 'Ali Hassan Traders', city: null, creditLimit: 5000 },
        admin,
      );
      expect(updated.name).toBe('Ali Hassan Traders');
      expect((await ledgerOf(party)).name).toBe('Ali Hassan Traders');

      const [entry] = await historyOf(party);
      expect(entry).toMatchObject({ action: 'updated', actorName: 'Admin' });
      expect(entry.changes).toEqual([
        { field: 'name', label: 'Name', from: 'Ali Traders', to: 'Ali Hassan Traders' },
        { field: 'city', label: 'City', from: 'Ajman', to: null },
        { field: 'creditLimit', label: 'Credit limit', from: null, to: 5000 },
      ]);
    });

    it('keeps the ledger status in step and records a deactivation', async () => {
      const party = await create({ name: 'Ali Traders' });

      await service.update(party.id, { status: PartyStatus.INACTIVE }, admin);
      expect((await ledgerOf(party)).status).toBe(LedgerAccountStatus.INACTIVE);
      await service.update(party.id, { status: PartyStatus.ACTIVE }, admin);
      expect((await ledgerOf(party)).status).toBe(LedgerAccountStatus.ACTIVE);

      expect((await historyOf(party)).map((entry) => entry.action)).toEqual(['updated', 'deactivated', 'created']);
    });

    it('rolls back the rename, the ledger rename and the audit entry when the save fails', async () => {
      const party = await create({ name: 'Ali Traders' });
      const record = auditService.record.bind(auditService);
      vi.spyOn(auditService, 'record').mockImplementationOnce(async (entry, session) => {
        await record(entry, session);
        throw new Error('disk full');
      });

      await expect(service.update(party.id, { name: 'Renamed' }, admin)).rejects.toThrow('disk full');
      expect((await service.findById(party.id)).name).toBe('Ali Traders');
      expect((await ledgerOf(party)).name).toBe('Ali Traders');
      expect((await historyOf(party)).map((entry) => entry.action)).toEqual(['created']);
    });

    it('rolls back the party rename when the ledger rename fails', async () => {
      const party = await create({ name: 'Ali Traders' });
      vi.spyOn(ledgerService, 'syncSystemAccount').mockRejectedValueOnce(new Error('ledger down'));

      await expect(service.update(party.id, { name: 'Renamed' }, admin)).rejects.toThrow('ledger down');
      expect((await service.findById(party.id)).name).toBe('Ali Traders');
    });

    it('never changes the kind', async () => {
      const party = await create({ name: 'Ali Traders' });

      await expect(parse({ kind: SUPPLIER }, UpdatePartyDto)).rejects.toBeInstanceOf(BadRequestException);
      await expect(parse({ code: 'SUP-0001' }, UpdatePartyDto)).rejects.toBeInstanceOf(BadRequestException);

      // Immutable at the schema level too.
      const doc = (await partyModel.findById(party.id).exec())!;
      doc.kind = SUPPLIER;
      await doc.save();
      expect((await partyModel.findById(party.id).exec())!.kind).toBe(CUSTOMER);
    });

    it('rejects an update that changes nothing', async () => {
      const party = await create({ name: 'Ali Traders', creditDays: 30 });
      for (const dto of [{}, { name: 'Ali Traders' }, { creditDays: 30, status: PartyStatus.ACTIVE }]) {
        await expect(service.update(party.id, dto, admin)).rejects.toThrow('No changes to save');
      }
    });
  });

  describe('delete', () => {
    it('deletes the party and its ledger account when the balance is 0 and nothing uses it', async () => {
      const party = await create({ name: 'Ali Traders' });
      await expect(service.remove(party.id)).resolves.toEqual({ success: true });
      expect(await partyModel.countDocuments().exec()).toBe(0);
      expect(await ledgerModel.countDocuments().exec()).toBe(0);
    });

    it('is blocked by a non-zero ledger balance', async () => {
      const party = await create({ name: 'Ali Traders' });
      await ledgerModel.updateOne({ _id: party.ledgerAccountId }, { $set: { balance: -250 } }).exec();

      await expect(service.remove(party.id)).rejects.toThrow(
        'Cannot delete customer CUS-0001 (Ali Traders): its ledger balance is -250, not 0. Deactivate it instead.',
      );
      expect(await partyModel.countDocuments().exec()).toBe(1);
      await expect(service.update(party.id, { status: PartyStatus.INACTIVE }, admin)).resolves.toBeDefined();
    });

    it('is blocked when the ledger account is used, even at a zero balance', async () => {
      const party = await create({ name: 'Omar Farms' }, SUPPLIER);
      usedAccounts.add(party.ledgerAccountId);

      await expect(service.remove(party.id)).rejects.toThrow(/used by existing transactions\. Deactivate it instead/);
      expect(await ledgerModel.countDocuments().exec()).toBe(1);
    });

    it('also removes attached files', async () => {
      const party = await create({ name: 'Ali Traders' });
      const withDoc = await service.addDocument(party.id, fakeFile('licence.pdf'), { title: 'Trade licence' }, admin);

      await service.remove(party.id);
      expect(filesService.remove).toHaveBeenCalledWith(withDoc.documents[0].fileId);
    });

    it("cannot remove a party's ledger account through the Accounts API", async () => {
      const party = await create({ name: 'Ali Traders' });
      await expect(ledgerService.remove(party.ledgerAccountId)).rejects.toThrow(/system-managed/);
      await expect(ledgerService.update(party.ledgerAccountId, { name: 'X' })).rejects.toThrow(/system-managed/);
    });
  });

  describe('lookup', () => {
    async function seed() {
      const ali = await create({ name: 'Ali Traders' });
      await create({ name: 'Alia Sweets' });
      const old = await create({ name: 'Ali Old' });
      await service.update(old.id, { status: PartyStatus.INACTIVE }, admin);
      await create({ name: 'Ali Farms' }, SUPPLIER);
      await ledgerModel.updateOne({ _id: ali.ledgerAccountId }, { $set: { balance: -120.5 } }).exec();
      return { ali };
    }

    it('returns active parties of the requested kind matching q, with ledger and balance', async () => {
      const { ali } = await seed();

      expect(await service.lookup({ kind: CUSTOMER, q: 'ali', limit: 50 })).toEqual([
        {
          id: ali.id,
          code: 'CUS-0001',
          name: 'Ali Traders',
          kind: 'customer',
          ledgerAccountId: ali.ledgerAccountId,
          balance: -120.5,
        },
        {
          id: expect.any(String),
          code: 'CUS-0002',
          name: 'Alia Sweets',
          kind: 'customer',
          ledgerAccountId: expect.any(String),
          balance: 0,
        },
      ]);
      expect((await service.lookup({ kind: SUPPLIER, limit: 50 })).map((item) => item.code)).toEqual(['SUP-0001']);
      expect((await service.lookup({ q: 'farms', limit: 50 })).map((item) => item.kind)).toEqual(['supplier']);
      expect((await service.lookup({ q: 'cus-0002', limit: 50 })).map((item) => item.name)).toEqual(['Alia Sweets']);
      expect(await service.lookup({ q: 'old', limit: 50 })).toEqual([]);
    });

    it('lists with search on name, code and telephone, kind and status filters, and pages', async () => {
      await seed();
      await create({ name: 'Zaid', telephone: '06 744 1234' });

      expect((await service.list({ q: '744 12', page: 1, limit: 20 })).items.map((p) => p.name)).toEqual(['Zaid']);
      expect((await service.list({ q: 'SUP-', page: 1, limit: 20 })).items.map((p) => p.name)).toEqual(['Ali Farms']);
      expect((await service.list({ kind: CUSTOMER, status: PartyStatus.INACTIVE, page: 1, limit: 20 })).total).toBe(1);
      const page2 = await service.list({ kind: CUSTOMER, page: 2, limit: 3 });
      expect(page2).toMatchObject({ total: 4, page: 2, limit: 3 });
      expect(page2.items.map((p) => p.code)).toEqual(['CUS-0004']);
    });

    it('makes party and supplier ledger accounts findable in the accounts lookup', async () => {
      await seed();
      const found = await ledgerService.lookup({
        types: [LedgerAccountType.PARTY, LedgerAccountType.SUPPLIER],
        q: 'ali',
        limit: 50,
      });
      expect(found.map((account) => [account.code, account.type])).toEqual([
        ['CUS-0001', LedgerAccountType.PARTY],
        ['CUS-0002', LedgerAccountType.PARTY],
        ['SUP-0001', LedgerAccountType.SUPPLIER],
      ]);
      // Inactive party => inactive ledger account => not offered for posting.
      expect(found.map((account) => account.name)).not.toContain('Ali Old');
    });
  });

  function fakeFile(name: string): Express.Multer.File {
    return {
      originalname: name,
      mimetype: 'application/pdf',
      size: 4,
      buffer: Buffer.from('%PDF'),
    } as Express.Multer.File;
  }

  describe('documents', () => {
    it('uploads through the files module and exposes only our own file reference', async () => {
      tokenUser = {
        id: admin.id,
        email: 'a@x.ae',
        name: 'Admin',
        role: { id: 'r', name: 'admin' },
        permissions: [Permission.PARTIES_MANAGE],
      };
      const party = await create({ name: 'Omar Farms' }, SUPPLIER);

      const res = await request(app.getHttpServer())
        .post(`/parties/${party.id}/documents`)
        .field('title', 'Trade licence')
        .attach('file', Buffer.from('%PDF-1.7'), { filename: 'licence.pdf', contentType: 'application/pdf' });

      expect(res.status).toBe(201);
      expect(filesService.upload).toHaveBeenCalledWith(
        expect.objectContaining({ originalname: 'licence.pdf' }),
        { ownerType: FileOwnerType.SUPPLIER, ownerId: party.id },
        admin.id,
      );
      const [document] = res.body.documents;
      expect(document).toEqual({
        id: expect.any(String),
        fileId: expect.any(String),
        url: `/files/${document.fileId}`,
        title: 'Trade licence',
        uploadedAt: expect.any(String),
      });
      expect(JSON.stringify(res.body)).not.toMatch(/key|bucket|https?:/i);

      const removed = await request(app.getHttpServer()).delete(`/parties/${party.id}/documents/${document.id}`);
      expect(removed.status).toBe(200);
      expect(removed.body.documents).toEqual([]);
      expect(filesService.remove).toHaveBeenCalledWith(document.fileId);

      expect((await historyOf(party)).map((entry) => entry.changes[0]?.label ?? entry.action)).toEqual([
        'Document removed',
        'Document added',
        'created',
      ]);
    });

    it('defaults the title to the file name and removes the stored file if attaching fails', async () => {
      const party = await create({ name: 'Ali Traders' });
      expect((await service.addDocument(party.id, fakeFile('vat-cert.pdf'), {}, admin)).documents[0].title).toBe(
        'vat-cert.pdf',
      );
      expect(filesService.upload.mock.calls[0][1]).toEqual({ ownerType: FileOwnerType.PARTY, ownerId: party.id });

      vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('disk full'));
      await expect(service.addDocument(party.id, fakeFile('x.pdf'), {}, admin)).rejects.toThrow('disk full');
      const failedFileId = (await filesService.upload.mock.results[1].value).id;
      expect(filesService.remove).toHaveBeenCalledWith(failedFileId);
      expect((await service.findById(party.id)).documents).toHaveLength(1);
    });

    it('404s for an unknown document', async () => {
      const party = await create({ name: 'Ali Traders' });
      await expect(service.removeDocument(party.id, new Types.ObjectId().toString(), admin)).rejects.toThrow(
        /Document .* not found on CUS-0001/,
      );
      await expect(service.removeDocument(party.id, 'nope', admin)).rejects.toThrow(/not found/);
    });
  });

  describe('access', () => {
    it('lets any logged-in user read, but needs parties:manage to write', async () => {
      tokenUser = { id: admin.id, email: 'v@x.ae', name: 'Viewer', role: { id: 'r', name: 'viewer' }, permissions: [] };
      const party = await create({ name: 'Ali Traders' });
      const server = app.getHttpServer();

      expect((await request(server).get('/parties')).status).toBe(200);
      expect((await request(server).get('/parties/lookup').query({ kind: 'customer' })).status).toBe(200);
      expect((await request(server).get(`/parties/${party.id}`)).status).toBe(200);
      expect((await request(server).post('/parties').send({ kind: 'customer', name: 'X' })).status).toBe(403);
      expect((await request(server).patch(`/parties/${party.id}`).send({ name: 'X' })).status).toBe(403);
      expect((await request(server).delete(`/parties/${party.id}`)).status).toBe(403);
      expect((await request(server).post(`/parties/${party.id}/documents`)).status).toBe(403);
      expect(ADMIN_PERMISSIONS).toContain(Permission.PARTIES_MANAGE);
    });

    it('lists every customer in the lookup, with balances only for balances:view', async () => {
      await create({ name: 'Ali Traders' });
      const server = app.getHttpServer();
      const viewer = { id: admin.id, email: 'v@x.ae', name: 'Viewer', role: { id: 'r', name: 'viewer' } };

      tokenUser = { ...viewer, permissions: [] };
      const hidden = await request(server).get('/parties/lookup').query({ kind: 'customer' });
      expect(hidden.body).toEqual([
        { id: expect.any(String), code: 'CUS-0001', name: 'Ali Traders', kind: 'customer', ledgerAccountId: expect.any(String) },
      ]);

      tokenUser = { ...viewer, permissions: [Permission.BALANCES_VIEW] };
      const shown = await request(server).get('/parties/lookup').query({ kind: 'customer' });
      expect(shown.body[0]).toMatchObject({ code: 'CUS-0001', balance: 0 });
    });

    it('is accepted by comments and the activity timeline as entityType "party"', async () => {
      const party = await create({ name: 'Ali Traders' });
      await expect(entityAccess.assertReadable('party', party.id, tokenUser)).resolves.toEqual(
        new Types.ObjectId(party.id),
      );
      await expect(entityAccess.assertReadable('party', new Types.ObjectId().toString(), tokenUser)).rejects.toThrow(
        /not found/,
      );
    });
  });
});
