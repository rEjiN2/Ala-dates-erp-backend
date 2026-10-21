import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { mongooseTestRoot } from '../../../test/mongo-test-db.js';
import { CompanyService } from './company.service.js';
import { CompanyController } from './company.controller.js';
import { CompanySettings, CompanySettingsDocument, CompanySettingsSchema } from './schemas/company-settings.schema.js';
import { UpdateCompanySettingsDto } from './dto/update-company-settings.dto.js';
import { FilesService } from '../files/files.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditLog, AuditLogDocument, AuditLogSchema } from '../audit/schemas/audit-log.schema.js';
import { EntityAccessRegistry } from '../comments/entity-access.registry.js';
import { LedgerAccountService } from '../accounting/ledger-accounts/ledger-account.service.js';
import { LedgerAccountUsageRegistry } from '../accounting/ledger-accounts/ledger-account-usage.registry.js';
import { createAppValidationPipe } from '../../common/pipes/app-validation.pipe.js';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator.js';
import { ADMIN_PERMISSIONS, Permission } from '../roles/permissions.js';

/** Stand-in FilesService: just enough metadata and bytes for logo handling. */
const files = new Map<string, { originalName: string; mimeType: string; buffer?: Buffer }>();
const fakeFilesService = {
  describe: async (id: string) => {
    const file = files.get(id);
    if (!file) throw new Error(`File ${id} not found`);
    return { id, url: `/files/${id}`, originalName: file.originalName, mimeType: file.mimeType };
  },
  readBuffer: async (id: string) => {
    const file = files.get(id);
    if (!file?.buffer) throw new Error('storage unavailable');
    return { buffer: file.buffer, mimeType: file.mimeType };
  },
};

describe('Company profile (CompanyService)', () => {
  let moduleRef: TestingModule;
  let service: CompanyService;
  let auditService: AuditService;
  let settingsModel: Model<CompanySettingsDocument>;
  let auditModel: Model<AuditLogDocument>;
  const admin = { id: new Types.ObjectId().toString(), name: 'Admin' };
  const pipe = createAppValidationPipe();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('company'),
        MongooseModule.forFeature([
          { name: CompanySettings.name, schema: CompanySettingsSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
        ]),
      ],
      providers: [
        CompanyService,
        AuditService,
        EntityAccessRegistry,
        LedgerAccountUsageRegistry,
        // No default handover accounts are set in these tests.
        { provide: LedgerAccountService, useValue: { getSummaries: async () => new Map() } },
        { provide: FilesService, useValue: fakeFilesService },
      ],
    }).compile();
    service = moduleRef.get(CompanyService);
    auditService = moduleRef.get(AuditService);
    settingsModel = moduleRef.get(getModelToken(CompanySettings.name));
    auditModel = moduleRef.get(getModelToken(AuditLog.name));
    await Promise.all([settingsModel.init(), auditModel.init()]);
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    files.clear();
    await settingsModel.deleteMany({}).exec();
    await auditModel.collection.deleteMany({});
  });

  const parse = (body: object) =>
    pipe.transform(body, { type: 'body', metatype: UpdateCompanySettingsDto }) as Promise<UpdateCompanySettingsDto>;

  it('starts from the ALA DATES defaults, created once', async () => {
    const [a, b] = await Promise.all([service.get(), service.get()]);

    expect(a).toMatchObject({
      legalName: 'ALA DATES LLC',
      addressLine1: 'Jurf 3',
      city: 'Ajman',
      country: 'United Arab Emirates',
      currencyCode: 'AED',
      trn: null,
      logo: null,
      updatedBy: null,
    });
    expect(b.id).toBe(a.id);
    expect(await settingsModel.countDocuments().exec()).toBe(1);
  });

  it('keeps an edited profile when the defaults are ensured again (seed re-run)', async () => {
    await service.update(await parse({ legalName: 'Ala Dates Trading LLC', city: 'Dubai' }), admin);
    await service.ensure();

    expect(await service.get()).toMatchObject({ legalName: 'Ala Dates Trading LLC', city: 'Dubai' });
  });

  describe('TRN validation', () => {
    it('accepts exactly 15 digits, or nothing', async () => {
      expect((await parse({ legalName: 'X', trn: '100234567800003' })).trn).toBe('100234567800003');
      expect((await parse({ legalName: 'X', trn: ' 100234567800003 ' })).trn).toBe('100234567800003');
      expect((await parse({ legalName: 'X' })).trn).toBeUndefined();
      expect((await parse({ legalName: 'X', trn: '' })).trn).toBeNull();
      expect((await parse({ legalName: 'X', trn: null })).trn).toBeNull();
    });

    it('rejects anything else', async () => {
      for (const trn of [
        '10023456780000',
        '1002345678000031',
        '10023456780000A',
        '100-234-567-800-003',
        '1002 3456 7800 003',
      ]) {
        await expect(parse({ legalName: 'X', trn })).rejects.toBeInstanceOf(BadRequestException);
      }
    });
  });

  it('validates the rest of the profile', async () => {
    for (const body of [
      {},
      { legalName: '   ' },
      { legalName: 'X', email: 'not-an-email' },
      { legalName: 'X', currencyCode: 'DIRHAM' },
      { legalName: 'X', logoFileRef: 'logo.png' },
      { legalName: 'X', logoUrl: 'https://bucket.example.com/logo.png' },
    ]) {
      await expect(parse(body)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect((await parse({ legalName: 'X', currencyCode: 'usd' })).currencyCode).toBe('USD');
  });

  it('audits an update with a field diff, and replaces the whole profile', async () => {
    const before = await service.get();
    const updated = await service.update(
      await parse({
        legalName: 'ALA DATES LLC',
        addressLine1: 'Jurf 3',
        addressLine2: 'Warehouse 12',
        city: 'Ajman',
        // country omitted: PUT clears it
        phone: '+971 6 123 4567',
        trn: '100234567800003',
        receiptFooterText: 'Thank you for your business',
      }),
      admin,
    );

    expect(updated).toMatchObject({ country: null, trn: '100234567800003', updatedBy: { name: 'Admin' } });
    const [entry] = await auditService.findForEntity('company-settings', new Types.ObjectId(before.id));
    expect(entry).toMatchObject({ action: 'updated', actorName: 'Admin', entityRef: 'Company profile' });
    expect(entry.changes).toEqual([
      { field: 'addressLine2', label: 'Address line 2', from: null, to: 'Warehouse 12' },
      { field: 'country', label: 'Country', from: 'United Arab Emirates', to: null },
      { field: 'phone', label: 'Phone', from: null, to: '+971 6 123 4567' },
      { field: 'trn', label: 'TRN', from: null, to: '100234567800003' },
      { field: 'receiptFooterText', label: 'Receipt footer text', from: null, to: 'Thank you for your business' },
    ]);
  });

  it('writes no audit entry when nothing changed', async () => {
    const defaults = await service.get();
    const same = await service.update(
      await parse({
        legalName: 'ALA DATES LLC',
        addressLine1: 'Jurf 3',
        city: 'Ajman',
        country: 'United Arab Emirates',
      }),
      admin,
    );
    expect(same.updatedAt).toBeNull();
    expect(await auditService.findForEntity('company-settings', new Types.ObjectId(defaults.id))).toEqual([]);
  });

  it('stores the logo as a file reference and exposes only our own URL', async () => {
    const logoId = new Types.ObjectId().toString();
    files.set(logoId, { originalName: 'ala-logo.png', mimeType: 'image/png', buffer: Buffer.from('png-bytes') });

    const view = await service.update(await parse({ legalName: 'ALA DATES LLC', logoFileRef: logoId }), admin);
    expect(view.logo).toEqual({ id: logoId, url: `/files/${logoId}` });
    expect(JSON.stringify(view)).not.toMatch(/https?:|bucket|r2|mega/i);

    const [entry] = await auditService.findForEntity('company-settings', new Types.ObjectId(view.id));
    expect(entry.changes).toContainEqual({ field: 'logo', label: 'Logo', from: null, to: 'ala-logo.png' });

    const { logoDataUrl } = await service.getForPrinting();
    expect(logoDataUrl).toBe(`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`);
  });

  it('rejects a logo that is not a PNG or JPEG', async () => {
    const pdfId = new Types.ObjectId().toString();
    files.set(pdfId, { originalName: 'logo.pdf', mimeType: 'application/pdf' });
    await expect(service.update(await parse({ legalName: 'X', logoFileRef: pdfId }), admin)).rejects.toThrow(
      /PNG or JPEG/,
    );
  });

  it('prints without the logo when storage cannot serve it', async () => {
    const logoId = new Types.ObjectId().toString();
    files.set(logoId, { originalName: 'ala-logo.png', mimeType: 'image/png' });
    await service.update(await parse({ legalName: 'ALA DATES LLC', logoFileRef: logoId }), admin);

    await expect(service.getForPrinting()).resolves.toMatchObject({ logoDataUrl: null });
  });

  it('needs company:manage to update, which the admin role holds', () => {
    const routes = CompanyController.prototype as unknown as Record<'get' | 'update', object>;
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, routes.update)).toEqual([Permission.COMPANY_MANAGE]);
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, routes.get)).toBeUndefined();
    expect(ADMIN_PERMISSIONS).toContain(Permission.COMPANY_MANAGE);
  });
});
