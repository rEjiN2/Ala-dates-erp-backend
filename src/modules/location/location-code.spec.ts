import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { mongooseTestRoot } from '../../../test/mongo-test-db.js';
import type { Model } from 'mongoose';
import { LocationService } from './location.service.js';
import { Location, LocationDocument, LocationSchema, LocationType } from './schemas/location.schema.js';
import { CreateLocationDto } from './dto/create-location.dto.js';
import { UpdateLocationDto } from './dto/update-location.dto.js';
import { LOCATION_CODE_SEQUENCES } from './location-code.js';
import { SequenceService } from '../sequence/sequence.service.js';
import { Counter, CounterDocument, CounterSchema } from '../sequence/schemas/counter.schema.js';
import { createAppValidationPipe } from '../../common/pipes/app-validation.pipe.js';

describe('Location code generation', () => {
  let moduleRef: TestingModule;
  let service: LocationService;
  let sequenceService: SequenceService;
  let locationModel: Model<LocationDocument>;
  let counterModel: Model<CounterDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('location_codes'),
        MongooseModule.forFeature([
          { name: Location.name, schema: LocationSchema },
          { name: Counter.name, schema: CounterSchema },
        ]),
      ],
      providers: [LocationService, SequenceService],
    }).compile();

    service = moduleRef.get(LocationService);
    sequenceService = moduleRef.get(SequenceService);
    locationModel = moduleRef.get(getModelToken(Location.name));
    counterModel = moduleRef.get(getModelToken(Counter.name));
    // Build the unique index before any test relies on it.
    await locationModel.init();
    await counterModel.init();
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await locationModel.deleteMany({}).exec();
    await counterModel.deleteMany({}).exec();
  });

  async function createBranch(name = 'Branch'): Promise<LocationDocument> {
    return service.create({ name, type: LocationType.BRANCH });
  }

  it('gives sequential creates sequential codes', async () => {
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await createBranch(`Branch ${i}`)).code);
    }
    expect(codes).toEqual(['BR-0001', 'BR-0002', 'BR-0003']);
  });

  it('keeps one counter and prefix per type', async () => {
    const branch = await createBranch();
    const warehouse = await service.create({ name: 'WH', type: LocationType.WAREHOUSE, parentId: branch.id });
    const store = await service.create({ name: 'Store', type: LocationType.STORE, parentId: warehouse.id });
    const van = await service.create({ name: 'Van', type: LocationType.VAN, parentId: branch.id });
    const secondBranch = await createBranch();

    expect([branch.code, warehouse.code, store.code, van.code, secondBranch.code]).toEqual([
      'BR-0001',
      'WH-0001',
      'ST-0001',
      'VAN-0001',
      'BR-0002',
    ]);
  });

  it('grows naturally past 9999', async () => {
    await sequenceService.ensureAtLeast(LOCATION_CODE_SEQUENCES[LocationType.BRANCH].key, 9999);
    expect((await createBranch()).code).toBe('BR-10000');
  });

  it('gives 50 parallel creates 50 unique codes', async () => {
    const created = await Promise.all(Array.from({ length: 50 }, (_, i) => createBranch(`Branch ${i}`)));

    const codes = created.map((location) => location.code);
    expect(new Set(codes).size).toBe(50);
    expect([...codes].sort()).toEqual(
      Array.from({ length: 50 }, (_, i) => `BR-${(i + 1).toString().padStart(4, '0')}`),
    );
    expect(await locationModel.countDocuments().exec()).toBe(50);
  });

  it('does not consume a number when the create is rejected by validation', async () => {
    const van = await service.create({ name: 'Van', type: LocationType.VAN });
    await expect(
      service.create({ name: 'Branch under van', type: LocationType.BRANCH, parentId: van.id }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect((await createBranch()).code).toBe('BR-0001');
  });

  describe('client-supplied code', () => {
    const pipe = createAppValidationPipe();

    it('is rejected by the validation pipe on create', async () => {
      await expect(
        pipe.transform(
          { code: 'BR-9999', name: 'Sneaky', type: LocationType.BRANCH },
          { type: 'body', metatype: CreateLocationDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is rejected by the validation pipe on update', async () => {
      await expect(
        pipe.transform({ code: 'BR-9999' }, { type: 'body', metatype: UpdateLocationDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is ignored by the service even if it slips past the pipe', async () => {
      const created = await service.create({
        code: 'HAND-1',
        name: 'Sneaky',
        type: LocationType.BRANCH,
      } as CreateLocationDto);
      expect(created.code).toBe('BR-0001');
    });
  });

  describe('immutability on update', () => {
    it('keeps the code when update is given one', async () => {
      const branch = await createBranch();

      const updated = await service.update(branch.id, { name: 'Renamed', code: 'BR-0500' } as UpdateLocationDto);

      expect(updated.name).toBe('Renamed');
      expect(updated.code).toBe('BR-0001');
      expect((await locationModel.findById(branch.id).exec())?.code).toBe('BR-0001');
    });

    it('keeps the code even through a direct model $set', async () => {
      const branch = await createBranch();

      await locationModel.updateOne({ _id: branch._id }, { $set: { code: 'BR-0500', name: 'Renamed' } }).exec();
      const fresh = await locationModel.findById(branch.id).exec();
      fresh!.code = 'BR-0600';
      await fresh!.save();

      const reloaded = await locationModel.findById(branch.id).exec();
      expect(reloaded?.name).toBe('Renamed');
      expect(reloaded?.code).toBe('BR-0001');
    });
  });

  it('keeps the unique index on code as a safety net', async () => {
    const indexes = await locationModel.collection.indexes();
    expect(indexes.some((index) => index.key.code === 1 && index.unique === true)).toBe(true);
  });

  it('turns a collision with an unsynced manual code into a ConflictException, not a duplicate', async () => {
    await locationModel.create({ code: 'BR-0001', name: 'Legacy', type: LocationType.BRANCH });

    await expect(createBranch()).rejects.toBeInstanceOf(ConflictException);
    expect(await locationModel.countDocuments({ code: 'BR-0001' }).exec()).toBe(1);
  });
});
