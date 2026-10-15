import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { type CodeSequence, formatSequenceCode } from '../../sequence/code-sequence.js';
import { ProductGroupService } from './product-group.service.js';

interface FakeProductGroup {
  _id: string;
  code: string;
  name: string;
  under: string | null;
  save: () => Promise<FakeProductGroup>;
}

function id(): string {
  return new Types.ObjectId().toString();
}

function makeFakeGroup(overrides: Partial<Omit<FakeProductGroup, 'save'>> = {}): FakeProductGroup {
  const doc: FakeProductGroup = {
    _id: overrides._id ?? id(),
    code: overrides.code ?? 'CODE-1',
    name: overrides.name ?? 'Group 1',
    under: overrides.under ?? null,
    save: async () => doc,
  };
  return doc;
}

// Mimics the subset of Mongoose's chainable query builder the service relies
// on (.sort/.select/.lean/.exec) without needing a real MongoDB connection.
function queryMock<T>(result: T) {
  const query = {
    sort: () => query,
    select: () => query,
    lean: () => query,
    exec: async () => result,
  };
  return query;
}

describe('ProductGroupService', () => {
  let db: Map<string, FakeProductGroup>;
  let modelMock: {
    find: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    countDocuments: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
  };
  let service: ProductGroupService;
  let sequenceMock: { nextCode: ReturnType<typeof vi.fn> };
  let issued: number;

  beforeEach(() => {
    db = new Map<string, FakeProductGroup>();

    modelMock = {
      find: vi.fn(() => queryMock(Array.from(db.values()))),
      findById: vi.fn((groupId: string) => queryMock(db.get(groupId) ?? null)),
      create: vi.fn(async (input: Partial<FakeProductGroup>) => {
        const created = makeFakeGroup({
          code: input.code,
          name: input.name,
          under: input.under ? input.under.toString() : null,
        });
        db.set(created._id, created);
        return created;
      }),
      countDocuments: vi.fn(() => queryMock(0)),
      deleteOne: vi.fn(() => queryMock({ deletedCount: 1 })),
    };

    sequenceMock = { nextCode: vi.fn(async (sequence: CodeSequence) => formatSequenceCode(sequence, ++issued)) };
    issued = 0;

    service = new ProductGroupService(
      modelMock as unknown as ConstructorParameters<typeof ProductGroupService>[0],
      sequenceMock as unknown as ConstructorParameters<typeof ProductGroupService>[1],
    );
  });

  function seed(overrides: Partial<Omit<FakeProductGroup, 'save'>> = {}): FakeProductGroup {
    const doc = makeFakeGroup(overrides);
    db.set(doc._id, doc);
    return doc;
  }

  describe('create', () => {
    it('allows a top-level group with no parent', async () => {
      await expect(service.create({ name: 'Dates' })).resolves.toBeDefined();
    });

    it('allows nesting any group under any other group', async () => {
      const dates = seed({ code: 'DATES', name: 'Dates' });
      await expect(
        service.create({ name: 'Ajwa', under: dates._id }),
      ).resolves.toBeDefined();
    });

    it('rejects creating under a parent id that does not exist', async () => {
      await expect(
        service.create({ name: 'Ajwa', under: id() }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('wraps a duplicate code error as a ConflictException', async () => {
      modelMock.create.mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
      await expect(service.create({ name: 'Dates dup' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('update - reparenting and cycle protection', () => {
    it('allows reparenting a group that already has children, to a different valid parent', async () => {
      const oldParent = seed({ code: 'OLD', name: 'Old parent' });
      const group = seed({ code: 'MID', name: 'Mid group', under: oldParent._id });
      seed({ code: 'CHILD-1', name: 'Child 1', under: group._id });
      seed({ code: 'CHILD-2', name: 'Child 2', under: group._id });
      const newParent = seed({ code: 'NEW', name: 'New parent' });

      const updated = await service.update(group._id, { under: newParent._id });

      expect(updated.under?.toString()).toBe(newParent._id);
    });

    it('rejects setting a group as its own parent', async () => {
      const group = seed({ code: 'DATES', name: 'Dates' });
      await expect(service.update(group._id, { under: group._id })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects reparenting a group under one of its own descendants (circular reference)', async () => {
      const top = seed({ code: 'DATES', name: 'Dates' });
      const child = seed({ code: 'AJWA', name: 'Ajwa', under: top._id });

      await expect(service.update(top._id, { under: child._id })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects reparenting a deep descendant chain back onto its own ancestor', async () => {
      const grandparent = seed({ code: 'A', name: 'A' });
      const parent = seed({ code: 'B', name: 'B', under: grandparent._id });
      const child = seed({ code: 'C', name: 'C', under: parent._id });

      await expect(service.update(grandparent._id, { under: child._id })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects reparenting onto a parent id that does not exist', async () => {
      const group = seed({ code: 'DATES', name: 'Dates' });
      await expect(service.update(group._id, { under: id() })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('allows clearing a parent back to null (promoting to top-level)', async () => {
      const parent = seed({ code: 'DATES', name: 'Dates' });
      const child = seed({ code: 'AJWA', name: 'Ajwa', under: parent._id });

      const updated = await service.update(child._id, { under: null });

      expect(updated.under).toBeNull();
    });
  });

  describe('remove', () => {
    it('rejects deleting a group that still has children', async () => {
      const parent = seed({ code: 'DATES', name: 'Dates' });
      seed({ code: 'AJWA', name: 'Ajwa', under: parent._id });
      modelMock.countDocuments.mockReturnValueOnce(queryMock(1));

      await expect(service.remove(parent._id)).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows deleting a leaf group', async () => {
      const leaf = seed({ code: 'PACKAGING', name: 'Packaging Materials' });
      await expect(service.remove(leaf._id)).resolves.toEqual({ success: true });
    });
  });

  describe('getTree - mixed depth', () => {
    it('nests Dates -> Ajwa/Ambar/Sukari while keeping flat top-level groups childless', async () => {
      const dates = seed({ code: 'DATES', name: 'Dates' });
      seed({ code: 'AJWA', name: 'Ajwa', under: dates._id });
      seed({ code: 'AMBAR', name: 'Ambar', under: dates._id });
      seed({ code: 'SUKARI', name: 'Sukari', under: dates._id });
      seed({ code: 'PACKAGING', name: 'Packaging Materials' });
      seed({ code: 'GIFT', name: 'Gift & Bundle Items' });

      const tree = await service.getTree();

      expect(tree).toHaveLength(3);

      const datesNode = tree.find((node) => node.code === 'DATES');
      expect(datesNode?.children.map((child) => child.name).sort()).toEqual(['Ajwa', 'Ambar', 'Sukari']);
      expect(datesNode?.children.every((child) => child.children.length === 0)).toBe(true);

      const packagingNode = tree.find((node) => node.code === 'PACKAGING');
      expect(packagingNode?.children).toEqual([]);

      const giftNode = tree.find((node) => node.code === 'GIFT');
      expect(giftNode?.children).toEqual([]);
    });

    it('returns just the requested subtree when rootId is given', async () => {
      const dates = seed({ code: 'DATES', name: 'Dates' });
      seed({ code: 'AJWA', name: 'Ajwa', under: dates._id });
      seed({ code: 'PACKAGING', name: 'Packaging Materials' });

      const tree = await service.getTree(dates._id);

      expect(tree).toHaveLength(1);
      expect(tree[0].code).toBe('DATES');
      expect(tree[0].children.map((child) => child.code)).toEqual(['AJWA']);
    });

    it('throws NotFoundException for an unknown rootId', async () => {
      seed({ code: 'DATES', name: 'Dates' });
      await expect(service.getTree(id())).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
