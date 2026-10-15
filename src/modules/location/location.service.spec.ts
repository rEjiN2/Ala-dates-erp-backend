import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { mongooseTestRoot } from '../../../test/mongo-test-db.js';
import { LocationService } from './location.service.js';
import { Location, LocationDocument, LocationSchema, LocationStatus, LocationType } from './schemas/location.schema.js';
import { ALLOWED_PARENT_TYPES, MAX_LOCATION_LEVELS } from './location-hierarchy.js';
import { SequenceService } from '../sequence/sequence.service.js';
import { Counter, CounterDocument, CounterSchema } from '../sequence/schemas/counter.schema.js';

const { BRANCH, WAREHOUSE, STORE, VAN } = LocationType;

describe('LocationService hierarchy', () => {
  let moduleRef: TestingModule;
  let service: LocationService;
  let locationModel: Model<LocationDocument>;
  let counterModel: Model<CounterDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseTestRoot('location_hierarchy'),
        MongooseModule.forFeature([
          { name: Location.name, schema: LocationSchema },
          { name: Counter.name, schema: CounterSchema },
        ]),
      ],
      providers: [LocationService, SequenceService],
    }).compile();

    service = moduleRef.get(LocationService);
    locationModel = moduleRef.get(getModelToken(Location.name));
    counterModel = moduleRef.get(getModelToken(Counter.name));
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

  function add(type: LocationType, parent?: LocationDocument, name = `${type}`): Promise<LocationDocument> {
    return service.create({ name, type, parentId: parent?.id ?? null });
  }

  async function reload(location: LocationDocument): Promise<LocationDocument> {
    return (await locationModel.findById(location._id).exec())!;
  }

  function ids(locations: LocationDocument[]): string[] {
    return locations.map((location) => location.id);
  }

  function ancestorIds(location: LocationDocument): string[] {
    return location.ancestors.map((ancestorId) => ancestorId.toString());
  }

  /** branch(L1) > warehouse(L2) > store(L3) > van(L4) > van(L5) > van(L6): a full-depth chain. */
  async function fullDepthChain(): Promise<LocationDocument[]> {
    const branch = await add(BRANCH);
    const warehouse = await add(WAREHOUSE, branch);
    const store = await add(STORE, warehouse);
    const van4 = await add(VAN, store);
    const van5 = await add(VAN, van4);
    const van6 = await add(VAN, van5);
    return [branch, warehouse, store, van4, van5, van6];
  }

  describe('parent type rules (from ALLOWED_PARENT_TYPES)', () => {
    it('allows a Warehouse under a Warehouse', async () => {
      const warehouse = await add(WAREHOUSE);
      const subWarehouse = await add(WAREHOUSE, warehouse);
      expect(subWarehouse.parentId?.toString()).toBe(warehouse.id);
    });

    it('allows a Van under a Van', async () => {
      const van = await add(VAN);
      const subVan = await add(VAN, van);
      expect(subVan.parentId?.toString()).toBe(van.id);
    });

    it('allows a sub-sub-van, with ancestors ordered root to parent', async () => {
      const branch = await add(BRANCH);
      const van = await add(VAN, branch);
      const subVan = await add(VAN, van);

      const subSubVan = await add(VAN, subVan);

      expect(ancestorIds(subSubVan)).toEqual(ids([branch, van, subVan]));
      expect(subSubVan.depth).toBe(3);
    });

    it('allows a Store under a Van', async () => {
      const van = await add(VAN, await add(BRANCH));
      const store = await add(STORE, van);
      expect(store.parentId?.toString()).toBe(van.id);
    });

    it('allows a Branch under a Branch', async () => {
      const branch = await add(BRANCH);
      const subBranch = await add(BRANCH, branch);
      expect(subBranch.parentId?.toString()).toBe(branch.id);
    });

    it('allows every type at the top level', async () => {
      for (const type of [BRANCH, WAREHOUSE, STORE, VAN]) {
        await expect(add(type)).resolves.toMatchObject({ parentId: null, depth: 0 });
      }
    });

    it('rejects a Branch under a Van, with a message built from the map', async () => {
      const van = await add(VAN);
      await expect(add(BRANCH, van)).rejects.toThrow(
        new BadRequestException(
          `A branch cannot be placed under van ${van.code}. A branch must be top-level or sit under one of: branch.`,
        ),
      );
    });

    it('rejects a Branch under a Warehouse or a Store', async () => {
      await expect(add(BRANCH, await add(WAREHOUSE))).rejects.toBeInstanceOf(BadRequestException);
      await expect(add(BRANCH, await add(STORE))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('enforces the same rules when moving on update', async () => {
      const branch = await add(BRANCH);
      const store = await add(STORE);

      await expect(service.update(branch.id, { parentId: store.id })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      const moved = await service.update(store.id, { parentId: branch.id });
      expect(moved.parentId?.toString()).toBe(branch.id);
      expect((await service.update(store.id, { parentId: null })).parentId).toBeNull();
    });

    it('rejects changing type to one its own parent does not accept', async () => {
      const branch = await add(BRANCH);
      const warehouse = await add(WAREHOUSE, await add(VAN));

      await expect(service.update(warehouse.id, { type: BRANCH })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.update(branch.id, { type: WAREHOUSE })).resolves.toMatchObject({ type: WAREHOUSE });
    });

    it('rejects a type change that its existing children could not sit under', async () => {
      const branch = await add(BRANCH);
      await add(BRANCH, branch);

      await expect(service.update(branch.id, { type: WAREHOUSE })).rejects.toThrow(
        /child .* is a branch, which cannot sit under a warehouse/,
      );
    });

    it('rejects an unknown parent id', async () => {
      await expect(
        service.create({ name: 'Store', type: STORE, parentId: new Types.ObjectId().toString() }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('exposes the map unchanged through getRules()', () => {
      expect(service.getRules()).toEqual({ allowedParentTypes: ALLOWED_PARENT_TYPES, maxLevels: MAX_LOCATION_LEVELS });
      expect(JSON.parse(JSON.stringify(service.getRules())).allowedParentTypes).toEqual({
        branch: [null, 'branch'],
        warehouse: [null, 'branch', 'warehouse', 'store', 'van'],
        store: [null, 'branch', 'warehouse', 'store', 'van'],
        van: [null, 'branch', 'warehouse', 'store', 'van'],
      });
    });
  });

  describe('circular parents', () => {
    it('rejects making a location its own parent', async () => {
      const van = await add(VAN, await add(BRANCH));
      await expect(service.update(van.id, { parentId: van.id })).rejects.toThrow(/cannot be its own parent/);
    });

    it('rejects moving a Van under its own sub-sub-van', async () => {
      const branch = await add(BRANCH);
      const van = await add(VAN, branch);
      const subVan = await add(VAN, van);
      const subSubVan = await add(VAN, subVan);

      await expect(service.update(van.id, { parentId: subSubVan.id })).rejects.toThrow(/circular reference/);
      expect((await reload(van)).parentId?.toString()).toBe(branch.id);
    });

    it('lets only one of two concurrent cross-moves through (no cycle via a race)', async () => {
      const branch = await add(BRANCH);
      const vanA = await add(VAN, branch, 'A');
      const vanB = await add(VAN, branch, 'B');

      const outcomes = await Promise.allSettled([
        service.update(vanA.id, { parentId: vanB.id }),
        service.update(vanB.id, { parentId: vanA.id }),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const [a, b] = [await reload(vanA), await reload(vanB)];
      const aUnderB = a.parentId?.toString() === vanB.id;
      const bUnderA = b.parentId?.toString() === vanA.id;
      expect(aUnderB !== bUnderA).toBe(true);
    });
  });

  describe('ancestors and depth maintenance', () => {
    it('moving a Van that has sub-vans rewrites ancestors and depth of every descendant', async () => {
      const branch1 = await add(BRANCH);
      const van = await add(VAN, branch1);
      const subVan = await add(VAN, van);
      const subSubVan = await add(VAN, subVan);
      const branch2 = await add(BRANCH);
      const warehouse = await add(WAREHOUSE, branch2);
      const store = await add(STORE, warehouse);

      const moved = await service.update(van.id, { parentId: store.id });

      expect(ancestorIds(moved)).toEqual(ids([branch2, warehouse, store]));
      expect(moved.depth).toBe(3);

      const [freshSub, freshSubSub] = [await reload(subVan), await reload(subSubVan)];
      expect(ancestorIds(freshSub)).toEqual(ids([branch2, warehouse, store, van]));
      expect(freshSub.depth).toBe(4);
      expect(ancestorIds(freshSubSub)).toEqual(ids([branch2, warehouse, store, van, subVan]));
      expect(freshSubSub.depth).toBe(5);
      expect(freshSubSub.parentId?.toString()).toBe(subVan.id);
    });

    it('moving a sub-tree up shortens every descendant chain', async () => {
      const [branch, , , van4, van5, van6] = await fullDepthChain();

      await service.update(van4.id, { parentId: branch.id });

      expect((await reload(van4)).depth).toBe(1);
      expect(ancestorIds(await reload(van5))).toEqual(ids([branch, van4]));
      expect(ancestorIds(await reload(van6))).toEqual(ids([branch, van4, van5]));
      expect((await reload(van6)).depth).toBe(3);
    });

    it('leaves descendants untouched when an update does not move the location', async () => {
      const branch = await add(BRANCH);
      const van = await add(VAN, branch);
      const subVan = await add(VAN, van);

      await service.update(van.id, { name: 'Renamed' });

      expect(ancestorIds(await reload(subVan))).toEqual(ids([branch, van]));
    });
  });

  describe('max depth', () => {
    it(`allows exactly ${MAX_LOCATION_LEVELS} levels`, async () => {
      const chain = await fullDepthChain();
      expect(chain.map((location) => location.depth)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('rejects creating a 7th level, with a clear message', async () => {
      const chain = await fullDepthChain();

      await expect(add(VAN, chain[5])).rejects.toThrow(
        `the location hierarchy is limited to ${MAX_LOCATION_LEVELS} levels and this would make it 7 levels deep`,
      );
    });

    it('rejects a move whose deepest descendant would end up past the limit', async () => {
      const [, , , , van5] = await fullDepthChain();
      const otherBranch = await add(BRANCH);
      const van = await add(VAN, otherBranch);
      const subVan = await add(VAN, van);

      // van would land at level 6 and subVan at level 7.
      await expect(service.update(van.id, { parentId: van5.id })).rejects.toThrow(/7 levels deep/);
      expect((await reload(subVan)).depth).toBe(2);
    });
  });

  describe('delete and deactivate', () => {
    it('rejects deleting a location that has children, naming the problem', async () => {
      const branch = await add(BRANCH);
      await add(VAN, branch);
      await add(VAN, branch);

      await expect(service.remove(branch.id)).rejects.toThrow(
        new ConflictException(
          `Cannot delete ${branch.code} (${branch.name}): it still has 2 child location(s). Move or delete them first.`,
        ),
      );
      expect(await locationModel.countDocuments().exec()).toBe(3);
    });

    it('allows deleting a leaf', async () => {
      const van = await add(VAN, await add(BRANCH));
      await expect(service.remove(van.id)).resolves.toEqual({ success: true });
      expect(await locationModel.findById(van._id).exec()).toBeNull();
    });

    it('rejects deactivating a location with an active sub-location anywhere below it', async () => {
      const branch = await add(BRANCH);
      const van = await add(VAN, branch);
      await add(VAN, van);
      // Direct child inactive, grandchild still active (e.g. legacy data).
      await locationModel.updateOne({ _id: van._id }, { $set: { status: LocationStatus.INACTIVE } }).exec();

      await expect(service.update(branch.id, { status: LocationStatus.INACTIVE })).rejects.toThrow(
        /active sub-location\(s\) are still under it/,
      );
      expect((await reload(branch)).status).toBe(LocationStatus.ACTIVE);
    });

    it('allows deactivating once every sub-location is inactive', async () => {
      const branch = await add(BRANCH);
      const van = await add(VAN, branch);
      const subVan = await add(VAN, van);

      await service.update(subVan.id, { status: LocationStatus.INACTIVE });
      await service.update(van.id, { status: LocationStatus.INACTIVE });
      const updated = await service.update(branch.id, { status: LocationStatus.INACTIVE });

      expect(updated.status).toBe(LocationStatus.INACTIVE);
    });
  });

  describe('reads', () => {
    it('getTree nests the full depth', async () => {
      const [branch, warehouse, store, van4, van5, van6] = await fullDepthChain();
      await add(BRANCH, undefined, 'Other branch');

      const tree = await service.getTree();

      expect(tree).toHaveLength(2);
      const root = tree.find((node) => node.id === branch.id)!;
      let node = root;
      for (const expected of [warehouse, store, van4, van5, van6]) {
        expect(node.children.map((child) => child.id)).toEqual([expected.id]);
        node = node.children[0];
      }
      expect(node.depth).toBe(5);
      expect(node.children).toEqual([]);

      const subtree = await service.getTree(van4.id);
      expect(subtree[0].children[0].children[0].id).toBe(van6.id);
    });

    it('getDescendants returns a flat list at every depth, shallowest first, excluding the root', async () => {
      const [branch, warehouse, store, van4] = await fullDepthChain();
      await add(BRANCH, undefined, 'Unrelated');

      const descendants = await service.getDescendants(warehouse.id);

      expect(descendants.map((d) => [d.type, d.depth, d.relativeDepth])).toEqual([
        [STORE, 2, 1],
        [VAN, 3, 2],
        [VAN, 4, 3],
        [VAN, 5, 4],
      ]);
      expect(descendants[1]).toMatchObject({ id: van4.id, parentId: store.id });
      expect(descendants.some((d) => d.id === branch.id || d.id === warehouse.id)).toBe(false);
    });

    it('getDescendants rejects an unknown id', async () => {
      await expect(service.getDescendants(new Types.ObjectId().toString())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
