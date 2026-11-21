import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import { ProductService } from './product.service.js';
import { ProductController } from './product.controller.js';
import { ProductUsageRegistry } from './product-usage.registry.js';
import { Product, ProductDocument, ProductSchema, ProductType } from './schemas/product.schema.js';
import { CreateProductDto } from './dto/product.dto.js';
import { ProductGroup, ProductGroupDocument, ProductGroupSchema } from '../product-groups/schemas/product-group.schema.js';
import { Unit, UnitDocument, UnitSchema } from '../units/schemas/unit.schema.js';
import { UnitService } from '../units/unit.service.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { Counter, CounterDocument, CounterSchema } from '../../sequence/schemas/counter.schema.js';
import { FilesService } from '../../files/files.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditLog, AuditLogDocument, AuditLogSchema } from '../../audit/schemas/audit-log.schema.js';
import { EntityAccessRegistry } from '../../comments/entity-access.registry.js';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { createAppValidationPipe } from '../../../common/pipes/app-validation.pipe.js';
import { ADMIN_PERMISSIONS, VAN_SALESMAN_PERMISSIONS } from '../../roles/permissions.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';

const filesService = { upload: vi.fn(), remove: vi.fn(async () => ({ success: true as const })) };

describe('Products (ProductService)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let service: ProductService;
  let unitService: UnitService;
  let auditService: AuditService;
  let productModel: Model<ProductDocument>;
  let groupModel: Model<ProductGroupDocument>;
  let unitModel: Model<UnitDocument>;
  let counterModel: Model<CounterDocument>;
  let auditModel: Model<AuditLogDocument>;

  const admin = { id: new Types.ObjectId().toString(), name: 'Admin' };
  let tokenUser: AuthenticatedUser;
  const usedProducts = new Set<string>();

  let dates: ProductGroupDocument;
  let ajwa: ProductGroupDocument;
  let gifts: ProductGroupDocument;
  let kg: UnitDocument;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('products'),
        MongooseModule.forFeature([
          { name: Product.name, schema: ProductSchema },
          { name: ProductGroup.name, schema: ProductGroupSchema },
          { name: Unit.name, schema: UnitSchema },
          { name: Counter.name, schema: CounterSchema },
          { name: AuditLog.name, schema: AuditLogSchema },
        ]),
      ],
      controllers: [ProductController],
      providers: [
        ProductService,
        UnitService,
        ProductUsageRegistry,
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

    service = moduleRef.get(ProductService);
    unitService = moduleRef.get(UnitService);
    auditService = moduleRef.get(AuditService);
    productModel = moduleRef.get(getModelToken(Product.name));
    groupModel = moduleRef.get(getModelToken(ProductGroup.name));
    unitModel = moduleRef.get(getModelToken(Unit.name));
    counterModel = moduleRef.get(getModelToken(Counter.name));
    auditModel = moduleRef.get(getModelToken(AuditLog.name));
    await Promise.all([productModel.init(), groupModel.init(), unitModel.init(), counterModel.init(), auditModel.init()]);

    moduleRef.get(ProductUsageRegistry).register('test invoices', async (id) => usedProducts.has(id.toString()));

    dates = await groupModel.create({ code: 'PG-0001', name: 'Dates', under: null });
    ajwa = await groupModel.create({ code: 'PG-0002', name: 'Ajwa', under: dates._id });
    gifts = await groupModel.create({ code: 'PG-0003', name: 'Gifts', under: null });
    kg = await unitModel.create({ name: 'Kilogram', symbol: 'KG' });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  afterEach(async () => {
    usedProducts.clear();
    await productModel.deleteMany({}).exec();
    await counterModel.deleteMany({}).exec();
    await auditModel.collection.deleteMany({});
  });

  const create = (dto: Partial<CreateProductDto> & { name: string }) =>
    service.create(
      { productGroupId: ajwa.id, unitId: kg.id, type: ProductType.STOCK, ...dto } as CreateProductDto,
      admin,
    );

  const asUser = (permissions: readonly string[]) => {
    tokenUser = { id: admin.id, name: 'Tester', permissions: [...permissions] } as unknown as AuthenticatedUser;
  };

  it('creates a product under Dates > Ajwa with a unit, prices and VAT', async () => {
    const product = await create({ name: 'Ajwa Premium 1kg', salePrice: 85, purchasePrice: 60, barcode: '6291000000017' });
    expect(product).toMatchObject({
      code: 'PRD-0001',
      productGroup: { name: 'Ajwa' },
      unit: { symbol: 'KG' },
      salePrice: 85,
      purchasePrice: 60,
      vatRate: 5,
      status: 'active',
      imageUrl: null,
    });
    const zeroRated = await create({ name: 'Ajwa Loose', vatRate: 0 });
    expect(zeroRated).toMatchObject({ code: 'PRD-0002', vatRate: 0 });
  });

  it('rejects duplicate names (ignoring case) and barcodes; many products may have no barcode', async () => {
    await create({ name: 'Ajwa 500g', barcode: 'B-1' });
    await expect(create({ name: 'AJWA 500G' })).rejects.toBeInstanceOf(ConflictException);
    await expect(create({ name: 'Other', barcode: 'B-1' })).rejects.toBeInstanceOf(ConflictException);
    await create({ name: 'No barcode 1' });
    await expect(create({ name: 'No barcode 2' })).resolves.toMatchObject({ barcode: null });
  });

  it('enforces min <= reorder <= max and a valid group and unit', async () => {
    await expect(create({ name: 'X', minStock: 10, reorderLevel: 5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(create({ name: 'X', reorderLevel: 50, maxStock: 20 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(create({ name: 'X', productGroupId: new Types.ObjectId().toString() })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const product = await create({ name: 'X', minStock: 5, maxStock: 20 });
    await expect(service.update(product.id, { reorderLevel: 30 }, admin)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('hides purchasePrice without products:view-cost', async () => {
    const product = await create({ name: 'Ajwa 1kg', purchasePrice: 60, salePrice: 85 });

    asUser(VAN_SALESMAN_PERMISSIONS);
    const one = await request(app.getHttpServer()).get(`/products/${product.id}`).expect(200);
    expect(one.body).not.toHaveProperty('purchasePrice');
    const list = await request(app.getHttpServer()).get('/products').expect(200);
    expect(list.body.items[0]).not.toHaveProperty('purchasePrice');
    await request(app.getHttpServer()).post('/products').send({ name: 'Y' }).expect(403);

    asUser(ADMIN_PERMISSIONS);
    const full = await request(app.getHttpServer()).get(`/products/${product.id}`).expect(200);
    expect(full.body.purchasePrice).toBe(60);
  });

  it('filters the list by group (with descendants), search, type and status; lookup is light', async () => {
    await create({ name: 'Ajwa 1kg', barcode: '111' });
    await create({ name: 'Gift Box', productGroupId: gifts.id, type: ProductType.BUNDLE });
    const old = await create({ name: 'Old Ajwa' });
    await service.update(old.id, { status: 'inactive' as never }, admin);

    const names = async (query: object) => (await service.list(query as never)).items.map((item) => item.name).sort();
    expect(await names({ groupId: dates.id })).toEqual(['Ajwa 1kg', 'Old Ajwa']);
    expect(await names({ q: '111' })).toEqual(['Ajwa 1kg']);
    expect(await names({ type: ProductType.BUNDLE })).toEqual(['Gift Box']);
    expect(await names({ status: 'inactive' })).toEqual(['Old Ajwa']);

    asUser(ADMIN_PERMISSIONS);
    const lookup = await request(app.getHttpServer()).get(`/products/lookup?groupId=${dates.id}`).expect(200);
    expect(lookup.body).toEqual([
      { id: expect.any(String), code: 'PRD-0001', name: 'Ajwa 1kg', unit: { id: kg.id, name: 'Kilogram', symbol: 'KG' }, salePrice: 0, vatRate: 5 },
    ]);
  });

  it('lookup?for=sales lists only active stock products with stock at the location, within data scope', async () => {
    const withStock = await create({ name: 'Ajwa 1kg' });
    const noStock = await create({ name: 'Safawi 1kg' });
    const service5 = await create({ name: 'Delivery', type: ProductType.NON_STOCK });
    const location = new Types.ObjectId();
    const balances = moduleRef.get(getConnectionToken()).collection('stock_balances');
    await balances.insertMany([
      { productId: new Types.ObjectId(withStock.id), locationId: location, qty: 7 },
      { productId: new Types.ObjectId(noStock.id), locationId: location, qty: 0 },
      { productId: new Types.ObjectId(service5.id), locationId: location, qty: 3 },
    ]);

    asUser(ADMIN_PERMISSIONS);
    const ok = await request(app.getHttpServer()).get(`/products/lookup?for=sales&locationId=${location}`).expect(200);
    expect(ok.body).toEqual([expect.objectContaining({ id: withStock.id, availableQty: 7 })]);
    await request(app.getHttpServer()).get('/products/lookup?for=sales').expect(400);

    asUser(VAN_SALESMAN_PERMISSIONS);
    tokenUser = { ...tokenUser, dataScope: 'own', allowedLocationIds: [new Types.ObjectId().toString()] } as AuthenticatedUser;
    await request(app.getHttpServer()).get(`/products/lookup?for=sales&locationId=${location}`).expect(403);
  });

  it("a group's allowed units are enforced with a unitId field error, and its default unit fills an empty unit", async () => {
    const box = await unitModel.create({ name: 'Box', symbol: 'BOX' });
    await groupModel.updateOne({ _id: gifts._id }, { defaultUnitId: box._id, allowedUnitIds: [box._id] });

    await expect(create({ name: 'Bad unit', productGroupId: gifts.id, unitId: kg.id })).rejects.toMatchObject({
      response: { field: 'unitId' },
    });
    const defaulted = await create({ name: 'Gift 1', productGroupId: gifts.id, unitId: undefined });
    expect(defaulted.unit?.id).toBe(box.id);
    await expect(service.update(defaulted.id, { unitId: kg.id }, admin)).rejects.toMatchObject({ response: { field: 'unitId' } });
    const loose = await create({ name: 'Loose 1kg' });
    await expect(service.update(loose.id, { productGroupId: gifts.id }, admin)).rejects.toMatchObject({
      response: { field: 'unitId' },
    });
    await groupModel.updateOne({ _id: gifts._id }, { defaultUnitId: null, allowedUnitIds: [] });
  });

  it('maps an incoming type "bundle" to stock and derives isBundle from a saved recipe', async () => {
    asUser(ADMIN_PERMISSIONS);
    const body = { name: 'Old client', productGroupId: ajwa.id, unitId: kg.id, type: 'bundle' };
    const created = await request(app.getHttpServer()).post('/products').send(body).expect(201);
    expect(created.body).toMatchObject({ type: 'stock', isBundle: false });
    await moduleRef.get(getConnectionToken()).collection('bundle_recipes').insertOne({ bundleProductId: new Types.ObjectId(created.body.id) });
    const again = await request(app.getHttpServer()).get(`/products/${created.body.id}`).expect(200);
    expect(again.body.isBundle).toBe(true);
  });

  it('audits a field diff including price changes and rejects a no-change edit', async () => {
    const product = await create({ name: 'Ajwa 1kg', salePrice: 85, purchasePrice: 60 });
    await service.update(product.id, { salePrice: 90, purchasePrice: 62, productGroupId: gifts.id }, admin);
    await expect(service.update(product.id, { salePrice: 90 }, admin)).rejects.toBeInstanceOf(BadRequestException);

    const history = await auditService.findForEntity('product', new Types.ObjectId(product.id));
    const updated = history.find((entry) => entry.action === 'updated')!;
    expect(updated.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'salePrice', from: 85, to: 90 }),
        expect.objectContaining({ field: 'purchasePrice', from: 60, to: 62 }),
        expect.objectContaining({ field: 'productGroup', from: 'Ajwa', to: 'Gifts' }),
      ]),
    );
  });

  it('blocks deleting a referenced product, and a unit in use', async () => {
    const product = await create({ name: 'Ajwa 1kg' });
    usedProducts.add(product.id);
    await expect(service.remove(product.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(unitService.remove(kg.id)).rejects.toBeInstanceOf(ConflictException);

    usedProducts.clear();
    await expect(service.remove(product.id)).resolves.toEqual({ success: true });
  });
});
