import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Location, LocationDocument, LocationStatus, LocationType } from './schemas/location.schema.js';
import { CreateLocationDto } from './dto/create-location.dto.js';
import { UpdateLocationDto } from './dto/update-location.dto.js';
import { wouldCreateCycle } from '../../common/utils/cycle.util.js';
import { buildTree, type TreeNode } from '../../common/utils/tree.util.js';
import { runInTransaction } from '../../common/utils/transaction.util.js';
import { SequenceService } from '../sequence/sequence.service.js';
import { LOCATION_CODE_SEQUENCES } from './location-code.js';
import {
  ALLOWED_PARENT_TYPES,
  MAX_LOCATION_DEPTH,
  MAX_LOCATION_LEVELS,
  describeAllowedParents,
  isParentTypeAllowed,
} from './location-hierarchy.js';

export interface LocationTreeItem {
  id: string;
  code: string;
  name: string;
  type: LocationType;
  status: LocationStatus;
  parentId: string | null;
  depth: number;
}

export type LocationTreeNode = TreeNode<LocationTreeItem>;

export interface LocationDescendant extends LocationTreeItem {
  /** 1 for a direct child of the requested location, 2 for a grandchild, ... */
  relativeDepth: number;
}

export interface LocationRules {
  allowedParentTypes: typeof ALLOWED_PARENT_TYPES;
  maxLevels: number;
}

/** Where a location sits: derived from its parent, never from client input. */
interface Placement {
  ancestors: Types.ObjectId[];
  depth: number;
}

@Injectable()
export class LocationService {
  constructor(
    @InjectModel(Location.name) private readonly locationModel: Model<LocationDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly sequenceService: SequenceService,
  ) {}

  getRules(): LocationRules {
    return { allowedParentTypes: ALLOWED_PARENT_TYPES, maxLevels: MAX_LOCATION_LEVELS };
  }

  async findAll(): Promise<LocationDocument[]> {
    return this.locationModel.find().sort({ name: 1 }).exec();
  }

  async findById(id: string): Promise<LocationDocument> {
    return this.getByIdOrThrow(id);
  }

  async create(dto: CreateLocationDto): Promise<LocationDocument> {
    return this.inTransaction(async (session) => {
      const parent = await this.resolveParent(dto.parentId ?? null, session);
      this.assertValidParentType(dto.type, parent);

      const placement = this.placementUnder(parent);
      this.assertWithinMaxDepth(placement.depth, `Cannot add a ${dto.type} under ${parent?.code}`);

      if (parent) {
        await this.lockForTreeChange(parent._id, session);
      }

      // Issued inside the transaction, after validation: a rejected or rolled
      // back create leaves no gap in the type's code sequence.
      const code = await this.sequenceService.nextCode(LOCATION_CODE_SEQUENCES[dto.type], session);

      const [created] = await this.locationModel.create(
        [
          {
            code,
            name: dto.name,
            type: dto.type,
            parentId: parent?._id ?? null,
            ancestors: placement.ancestors,
            depth: placement.depth,
            status: dto.status ?? LocationStatus.ACTIVE,
          },
        ],
        { session },
      );
      return created;
    });
  }

  async update(id: string, dto: UpdateLocationDto): Promise<LocationDocument> {
    return this.inTransaction(async (session) => {
      const existing = await this.getByIdOrThrow(id, 'Location', session);
      const currentParentId = existing.parentId?.toString() ?? null;

      const nextType = dto.type ?? existing.type;
      const parentIdProvided = Object.prototype.hasOwnProperty.call(dto, 'parentId');
      const nextParentId = parentIdProvided ? (dto.parentId ?? null) : currentParentId;
      const isMove = nextParentId !== currentParentId;

      const parent = await this.resolveParent(nextParentId, session);
      if (isMove && parent) {
        await this.assertNotCircular(existing, parent, session);
      }
      this.assertValidParentType(nextType, parent);

      if (nextType !== existing.type) {
        await this.assertChildrenAllowUnder(existing, nextType, session);
      }
      if (dto.status === LocationStatus.INACTIVE && existing.status !== LocationStatus.INACTIVE) {
        await this.assertNoActiveDescendants(existing, session);
      }

      const placement = this.placementUnder(parent);
      if (isMove) {
        await this.assertSubtreeFits(existing, placement, session);
      }

      if (parent) {
        await this.lockForTreeChange(parent._id, session);
      }

      const oldAncestorCount = existing.ancestors.length;
      if (dto.name !== undefined) existing.name = dto.name;
      if (dto.status !== undefined) existing.status = dto.status;
      existing.type = nextType;
      existing.parentId = parent?._id ?? null;
      existing.ancestors = placement.ancestors;
      existing.depth = placement.depth;
      await existing.save({ session });

      if (isMove) {
        await this.reparentDescendants(existing, oldAncestorCount, session);
      }
      return existing;
    });
  }

  async remove(id: string): Promise<{ success: true }> {
    return this.inTransaction(async (session) => {
      const existing = await this.getByIdOrThrow(id, 'Location', session);

      const childCount = await this.locationModel
        .countDocuments({ parentId: existing._id })
        .session(session)
        .exec();
      if (childCount > 0) {
        throw new ConflictException(
          `Cannot delete ${existing.code} (${existing.name}): it still has ${childCount} child location(s). Move or delete them first.`,
        );
      }

      await this.locationModel.deleteOne({ _id: existing._id }, { session }).exec();
      return { success: true as const };
    });
  }

  async getTree(rootId?: string): Promise<LocationTreeNode[]> {
    const allLocations = await this.locationModel.find().sort({ name: 1 }).lean().exec();
    const items = allLocations.map((location) => this.toTreeItem(location));

    if (rootId && !items.some((item) => item.id === rootId)) {
      throw new NotFoundException(`Location ${rootId} not found`);
    }

    return buildTree(items, rootId);
  }

  /** Every location below `id` at any depth, shallowest first. */
  async getDescendants(id: string): Promise<LocationDescendant[]> {
    const root = await this.getByIdOrThrow(id);
    const descendants = await this.locationModel
      .find({ ancestors: root._id })
      .sort({ depth: 1, name: 1 })
      .lean()
      .exec();

    return descendants.map((location) => ({
      ...this.toTreeItem(location),
      relativeDepth: location.depth - root.depth,
    }));
  }

  private assertValidParentType(type: LocationType, parent: LocationDocument | null): void {
    if (!isParentTypeAllowed(type, parent?.type ?? null)) {
      const placedAs = parent ? `under ${parent.type} ${parent.code}` : 'at the top level';
      throw new BadRequestException(`A ${type} cannot be placed ${placedAs}. ${describeAllowedParents(type)}.`);
    }
  }

  private assertWithinMaxDepth(depth: number, action: string): void {
    if (depth > MAX_LOCATION_DEPTH) {
      throw new BadRequestException(
        `${action}: the location hierarchy is limited to ${MAX_LOCATION_LEVELS} levels and this would make it ${depth + 1} levels deep.`,
      );
    }
  }

  private async assertNotCircular(
    location: LocationDocument,
    newParent: LocationDocument,
    session: ClientSession,
  ): Promise<void> {
    // Walks the parentId chain (the source of truth) rather than trusting the
    // ancestors cache, so this holds even for data not yet backfilled.
    const isCycle = await wouldCreateCycle(location.id, newParent.id, (candidateId) =>
      this.getParentIdOf(candidateId, session),
    );
    if (isCycle) {
      throw new BadRequestException(
        newParent.id === location.id
          ? `${location.code} cannot be its own parent`
          : `Cannot move ${location.code} under ${newParent.code}: ${newParent.code} is inside ${location.code}'s own sub-tree, which would create a circular reference`,
      );
    }
  }

  private async assertChildrenAllowUnder(
    location: LocationDocument,
    nextType: LocationType,
    session: ClientSession,
  ): Promise<void> {
    const children = await this.locationModel
      .find({ parentId: location._id })
      .select('code type')
      .session(session)
      .lean()
      .exec();

    const misfit = children.find((child) => !isParentTypeAllowed(child.type, nextType));
    if (misfit) {
      throw new BadRequestException(
        `Cannot change ${location.code} to a ${nextType}: its child ${misfit.code} is a ${misfit.type}, which cannot sit under a ${nextType}. ${describeAllowedParents(misfit.type)}.`,
      );
    }
  }

  private async assertNoActiveDescendants(location: LocationDocument, session: ClientSession): Promise<void> {
    // parentId catches direct children even if the ancestors cache is stale.
    const activeCount = await this.locationModel
      .countDocuments({
        $or: [{ parentId: location._id }, { ancestors: location._id }],
        status: LocationStatus.ACTIVE,
      })
      .session(session)
      .exec();

    if (activeCount > 0) {
      throw new ConflictException(
        `Cannot deactivate ${location.code} (${location.name}): ${activeCount} active sub-location(s) are still under it. Deactivate or move them first.`,
      );
    }
  }

  /** The moved location's deepest descendant must also stay within the limit. */
  private async assertSubtreeFits(
    location: LocationDocument,
    placement: Placement,
    session: ClientSession,
  ): Promise<void> {
    const deepest = await this.locationModel
      .findOne({ ancestors: location._id })
      .sort({ depth: -1 })
      .select('depth')
      .session(session)
      .lean()
      .exec();

    const subtreeHeight = deepest ? deepest.depth - location.depth : 0;
    this.assertWithinMaxDepth(placement.depth + subtreeHeight, `Cannot move ${location.code} there`);
  }

  /**
   * Rewrites ancestors/depth for everything under a moved location, in the
   * caller's transaction. Each descendant keeps the part of its chain from the
   * moved location downwards and gets the moved location's new chain above it.
   */
  private async reparentDescendants(
    moved: LocationDocument,
    oldAncestorCount: number,
    session: ClientSession,
  ): Promise<void> {
    const descendants = await this.locationModel
      .find({ ancestors: moved._id })
      .select('ancestors')
      .session(session)
      .lean()
      .exec();
    if (descendants.length === 0) {
      return;
    }

    const operations = descendants.map((descendant) => {
      const index = descendant.ancestors.findIndex((ancestorId) => ancestorId.equals(moved._id));
      const fromMoved = descendant.ancestors.slice(index >= 0 ? index : oldAncestorCount);
      const ancestors = [...moved.ancestors, ...fromMoved];
      return {
        updateOne: {
          filter: { _id: descendant._id },
          update: { $set: { ancestors, depth: ancestors.length } },
        },
      };
    });

    await this.locationModel.bulkWrite(operations, { session });
  }

  /**
   * Forces a real write on the location a change attaches to. Transactions are
   * snapshot-isolated, so without a shared write two concurrent changes could
   * each pass validation against the old tree (e.g. A under B and B under A)
   * and both commit. The write makes them conflict; the loser is retried and
   * re-validated against the winner's result.
   */
  private async lockForTreeChange(locationId: Types.ObjectId, session: ClientSession): Promise<void> {
    await this.locationModel.updateOne({ _id: locationId }, { $inc: { treeVersion: 1 } }, { session }).exec();
  }

  private placementUnder(parent: LocationDocument | null): Placement {
    if (!parent) {
      return { ancestors: [], depth: 0 };
    }
    const ancestors = [...parent.ancestors, parent._id];
    return { ancestors, depth: ancestors.length };
  }

  private async resolveParent(parentId: string | null, session?: ClientSession): Promise<LocationDocument | null> {
    if (!parentId) {
      return null;
    }
    return this.getByIdOrThrow(parentId, 'Parent location', session);
  }

  private async getByIdOrThrow(id: string, label = 'Location', session?: ClientSession): Promise<LocationDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`${label} id "${id}" is not a valid id`);
    }
    const location = await this.locationModel
      .findById(id)
      .session(session ?? null)
      .exec();
    if (!location) {
      throw new NotFoundException(`${label} ${id} not found`);
    }
    return location;
  }

  private async getParentIdOf(id: string, session: ClientSession): Promise<string | null> {
    const location = await this.locationModel.findById(id).select('parentId').session(session).lean().exec();
    return location?.parentId ? location.parentId.toString() : null;
  }

  private toTreeItem(location: Location & { _id: Types.ObjectId }): LocationTreeItem {
    return {
      id: location._id.toString(),
      code: location.code,
      name: location.name,
      type: location.type,
      status: location.status,
      parentId: location.parentId ? location.parentId.toString() : null,
      depth: location.depth,
    };
  }

  private async inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    try {
      return await runInTransaction(this.connection, work);
    } catch (error) {
      throw this.toFriendlyError(error);
    }
  }

  private toFriendlyError(error: unknown): unknown {
    if (this.isDuplicateKeyError(error)) {
      return new ConflictException(
        'Generated location code is already in use; the code counter is behind existing data and needs re-syncing (pnpm migrate:code-sequences)',
      );
    }
    return error;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
  }
}
