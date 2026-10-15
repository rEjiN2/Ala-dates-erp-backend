import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { mongooseTestRoot } from '../../test/mongo-test-db.js';
import type { Model } from 'mongoose';
import { syncCodeSequences } from './sync-code-sequences.js';
import { LocationService } from '../modules/location/location.service.js';
import {
  Location,
  LocationDocument,
  LocationSchema,
  LocationType,
} from '../modules/location/schemas/location.schema.js';
import { ProductGroupService } from '../modules/product/product-groups/product-group.service.js';
import {
  ProductGroup,
  ProductGroupDocument,
  ProductGroupSchema,
} from '../modules/product/product-groups/schemas/product-group.schema.js';
import { SequenceService } from '../modules/sequence/sequence.service.js';
import { Counter, CounterDocument, CounterSchema } from '../modules/sequence/schemas/counter.schema.js';

describe('syncCodeSequences', () => {
  let moduleRef: TestingModule;
  let locationService: LocationService;
  let productGroupService: ProductGroupService;
  let sequenceService: SequenceService;
  let locationModel: Model<LocationDocument>;
  let productGroupModel: Model<ProductGroupDocument>;
  let counterModel: Model<CounterDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('sync_code_sequences'),
        MongooseModule.forFeature([
          { name: Location.name, schema: LocationSchema },
          { name: ProductGroup.name, schema: ProductGroupSchema },
          { name: Counter.name, schema: CounterSchema },
        ]),
      ],
      providers: [LocationService, ProductGroupService, SequenceService],
    }).compile();

    locationService = moduleRef.get(LocationService);
    productGroupService = moduleRef.get(ProductGroupService);
    sequenceService = moduleRef.get(SequenceService);
    locationModel = moduleRef.get(getModelToken(Location.name));
    productGroupModel = moduleRef.get(getModelToken(ProductGroup.name));
    counterModel = moduleRef.get(getModelToken(Counter.name));
    await Promise.all([locationModel.init(), productGroupModel.init(), counterModel.init()]);
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await locationModel.deleteMany({}).exec();
    await productGroupModel.deleteMany({}).exec();
    await counterModel.deleteMany({}).exec();
  });

  function sync() {
    return syncCodeSequences({ locationModel, productGroupModel, sequenceService });
  }

  async function seedLegacyData() {
    // Codes entered by hand before generation existed, raw-inserted as they
    // would be in the database.
    await locationModel.insertMany([
      { code: 'BR-0003', name: 'Old branch', type: LocationType.BRANCH },
      { code: 'BR-0012', name: 'Old branch 2', type: LocationType.BRANCH },
      { code: 'RIYADH', name: 'Free-text code', type: LocationType.BRANCH },
      { code: 'WH-0007', name: 'Old warehouse', type: LocationType.WAREHOUSE },
      // Wrong-type prefix still occupies BR-0020 in the collection-wide index.
      { code: 'BR-0020', name: 'Warehouse coded like a branch', type: LocationType.WAREHOUSE },
      { code: 'VAN-01-OLD', name: 'Non-matching van', type: LocationType.VAN },
    ]);
    await productGroupModel.insertMany([
      { code: 'PG-0040', name: 'Old group' },
      { code: 'DATES', name: 'Free-text group' },
    ]);
  }

  it('sets each counter to the highest existing suffix for its prefix', async () => {
    await seedLegacyData();

    const results = await sync();
    const byKey = Object.fromEntries(results.map((result) => [result.key, result.counter]));

    expect(byKey).toEqual({
      'location:branch': 20,
      'location:warehouse': 7,
      'location:store': 0,
      'location:van': 0,
      'product-group': 40,
    });

    expect((await locationService.create({ name: 'New', type: LocationType.BRANCH })).code).toBe('BR-0021');
    expect((await locationService.create({ name: 'New', type: LocationType.WAREHOUSE })).code).toBe('WH-0008');
    expect((await productGroupService.create({ name: 'New' })).code).toBe('PG-0041');
  });

  it('leaves records with non-matching codes untouched', async () => {
    await seedLegacyData();
    const before = await locationModel.find().sort({ _id: 1 }).lean().exec();
    const groupsBefore = await productGroupModel.find().sort({ _id: 1 }).lean().exec();

    await sync();

    expect(await locationModel.find().sort({ _id: 1 }).lean().exec()).toEqual(before);
    expect(await productGroupModel.find().sort({ _id: 1 }).lean().exec()).toEqual(groupsBefore);
  });

  it('is safe to re-run and never lowers a counter that is already ahead', async () => {
    await seedLegacyData();
    await sync();
    await sequenceService.ensureAtLeast('location:branch', 100);

    await sync();

    expect((await locationService.create({ name: 'New', type: LocationType.BRANCH })).code).toBe('BR-0101');
  });
});
