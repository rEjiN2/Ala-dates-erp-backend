import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { mongooseTestRoot } from '../../../../test/mongo-test-db.js';
import type { Model } from 'mongoose';
import { ProductGroupService } from './product-group.service.js';
import { ProductGroup, ProductGroupDocument, ProductGroupSchema } from './schemas/product-group.schema.js';
import { CreateProductGroupDto } from './dto/create-product-group.dto.js';
import { UpdateProductGroupDto } from './dto/update-product-group.dto.js';
import { Product, ProductSchema } from '../products/schemas/product.schema.js';
import { SequenceService } from '../../sequence/sequence.service.js';
import { Counter, CounterDocument, CounterSchema } from '../../sequence/schemas/counter.schema.js';
import { createAppValidationPipe } from '../../../common/pipes/app-validation.pipe.js';

describe('Product group code generation', () => {
  let moduleRef: TestingModule;
  let service: ProductGroupService;
  let productGroupModel: Model<ProductGroupDocument>;
  let counterModel: Model<CounterDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('product_group_codes'),
        MongooseModule.forFeature([
          { name: ProductGroup.name, schema: ProductGroupSchema },
          { name: Product.name, schema: ProductSchema },
          { name: Counter.name, schema: CounterSchema },
        ]),
      ],
      providers: [ProductGroupService, SequenceService],
    }).compile();

    service = moduleRef.get(ProductGroupService);
    productGroupModel = moduleRef.get(getModelToken(ProductGroup.name));
    counterModel = moduleRef.get(getModelToken(Counter.name));
    await productGroupModel.init();
    await counterModel.init();
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await productGroupModel.deleteMany({}).exec();
    await counterModel.deleteMany({}).exec();
  });

  it('gives sequential creates sequential codes, nested or not', async () => {
    const dates = await service.create({ name: 'Dates' });
    const ajwa = await service.create({ name: 'Ajwa', under: dates.id });
    const packaging = await service.create({ name: 'Packaging' });

    expect([dates.code, ajwa.code, packaging.code]).toEqual(['PG-0001', 'PG-0002', 'PG-0003']);
  });

  it('gives 50 parallel creates 50 unique codes', async () => {
    const created = await Promise.all(Array.from({ length: 50 }, (_, i) => service.create({ name: `Group ${i}` })));

    const codes = created.map((group) => group.code);
    expect(new Set(codes).size).toBe(50);
    expect([...codes].sort()).toEqual(
      Array.from({ length: 50 }, (_, i) => `PG-${(i + 1).toString().padStart(4, '0')}`),
    );
  });

  describe('client-supplied code', () => {
    const pipe = createAppValidationPipe();

    it('is rejected by the validation pipe on create', async () => {
      await expect(
        pipe.transform({ code: 'PG-9999', name: 'Sneaky' }, { type: 'body', metatype: CreateProductGroupDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is rejected by the validation pipe on update', async () => {
      await expect(
        pipe.transform({ code: 'PG-9999' }, { type: 'body', metatype: UpdateProductGroupDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is ignored by the service even if it slips past the pipe', async () => {
      const created = await service.create({ code: 'HAND-1', name: 'Sneaky' } as CreateProductGroupDto);
      expect(created.code).toBe('PG-0001');
    });
  });

  it('cannot change the code on update', async () => {
    const group = await service.create({ name: 'Dates' });

    const updated = await service.update(group.id, { name: 'Dates (all)', code: 'PG-0500' } as UpdateProductGroupDto);
    await productGroupModel.updateOne({ _id: group._id }, { $set: { code: 'PG-0600' } }).exec();

    expect(updated.name).toBe('Dates (all)');
    expect(updated.code).toBe('PG-0001');
    expect((await productGroupModel.findById(group.id).exec())?.code).toBe('PG-0001');
  });

  it('keeps the unique index on code as a safety net', async () => {
    await productGroupModel.create({ code: 'PG-0001', name: 'Legacy' });

    await expect(service.create({ name: 'New' })).rejects.toBeInstanceOf(ConflictException);
    expect(await productGroupModel.countDocuments({ code: 'PG-0001' }).exec()).toBe(1);
  });
});
