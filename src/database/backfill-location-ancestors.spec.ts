import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { mongooseTestRoot } from '../../test/mongo-test-db.js';
import { backfillLocationAncestors } from './backfill-location-ancestors.js';
import { Location, LocationDocument, LocationSchema, LocationType } from '../modules/location/schemas/location.schema.js';

describe('backfillLocationAncestors', () => {
  let moduleRef: TestingModule;
  let locationModel: Model<LocationDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('backfill_location_ancestors'),
        MongooseModule.forFeature([{ name: Location.name, schema: LocationSchema }]),
      ],
    }).compile();
    locationModel = moduleRef.get(getModelToken(Location.name));
    await locationModel.init();
  }, 120_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  afterEach(async () => {
    await locationModel.deleteMany({}).exec();
  });

  /** Raw insert, bypassing Mongoose defaults, exactly like pre-migration records. */
  async function legacy(code: string, type: LocationType, parentId: Types.ObjectId | null = null) {
    const _id = new Types.ObjectId();
    await locationModel.collection.insertOne({ _id, code, name: code, type, parentId, status: 'active' });
    return _id;
  }

  async function raw(id: Types.ObjectId) {
    return locationModel.collection.findOne({ _id: id });
  }

  it('fills ancestors (root to parent) and depth from the parentId chain', async () => {
    const branch = await legacy('BR-0001', LocationType.BRANCH);
    const store = await legacy('ST-0001', LocationType.STORE, branch);
    const van = await legacy('VAN-0001', LocationType.VAN, store);
    const subVan = await legacy('VAN-0002', LocationType.VAN, van);

    const result = await backfillLocationAncestors(locationModel);

    expect(result).toMatchObject({ scanned: 4, updated: 4, skipped: [], tooDeep: [] });
    expect(await raw(branch)).toMatchObject({ ancestors: [], depth: 0 });
    expect(await raw(store)).toMatchObject({ ancestors: [branch], depth: 1 });
    expect(await raw(subVan)).toMatchObject({ ancestors: [branch, store, van], depth: 3 });
  });

  it('is idempotent: a second run writes nothing', async () => {
    const branch = await legacy('BR-0001', LocationType.BRANCH);
    await legacy('WH-0001', LocationType.WAREHOUSE, branch);

    await backfillLocationAncestors(locationModel);
    const second = await backfillLocationAncestors(locationModel);

    expect(second.updated).toBe(0);
  });

  it('reports and leaves alone records with a missing parent or a circular chain', async () => {
    const orphan = await legacy('VAN-0001', LocationType.VAN, new Types.ObjectId());
    const loopA = new Types.ObjectId();
    const loopB = await legacy('VAN-0002', LocationType.VAN, loopA);
    await locationModel.collection.insertOne({
      _id: loopA,
      code: 'VAN-0003',
      name: 'loop',
      type: LocationType.VAN,
      parentId: loopB,
      status: 'active',
    });

    const result = await backfillLocationAncestors(locationModel);

    expect(result.updated).toBe(0);
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped.find((entry) => entry.startsWith('VAN-0001'))).toMatch(/does not exist/);
    expect(result.skipped.find((entry) => entry.startsWith('VAN-0002'))).toMatch(/circular/);
    expect((await raw(orphan))?.ancestors).toBeUndefined();
  });

  it('writes but flags a chain already deeper than the level limit', async () => {
    let parent = await legacy('BR-0001', LocationType.BRANCH);
    for (let level = 2; level <= 7; level++) {
      parent = await legacy(`VAN-000${level}`, LocationType.VAN, parent);
    }

    const result = await backfillLocationAncestors(locationModel);

    expect(result.tooDeep).toEqual(['VAN-0007: level 7 (max 6)']);
    expect(await raw(parent)).toMatchObject({ depth: 6 });
  });
});
