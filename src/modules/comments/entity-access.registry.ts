import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

export interface EntityAccessHandler {
  /** Whether a record with this id exists. */
  exists(id: Types.ObjectId): Promise<boolean>;
  /** Whether this user may read records of this type. Mirror the entity's own GET route guards. */
  canRead(user: AuthenticatedUser): boolean;
}

/**
 * Lets comments and the activity timeline attach to any entity without
 * knowing about it. Each owning module registers its entity type from a
 * provider constructor (same pattern as LedgerAccountUsageRegistry), which
 * keeps the dependency pointing from the entity module to this one.
 */
@Injectable()
export class EntityAccessRegistry {
  private readonly handlers = new Map<string, EntityAccessHandler>();

  register(entityType: string, handler: EntityAccessHandler): void {
    this.handlers.set(entityType, handler);
  }

  /** Resolves the entity id once the user is known to be allowed to read it; throws 400/403/404 otherwise. */
  async assertReadable(entityType: string, entityId: string, user: AuthenticatedUser): Promise<Types.ObjectId> {
    const handler = this.handlers.get(entityType);
    if (!handler) {
      throw new BadRequestException(`Unknown entityType "${entityType}"`);
    }
    if (!Types.ObjectId.isValid(entityId)) {
      throw new BadRequestException(`entityId "${entityId}" is not a valid id`);
    }
    if (!handler.canRead(user)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const id = new Types.ObjectId(entityId);
    if (!(await handler.exists(id))) {
      throw new NotFoundException(`${entityType} ${entityId} not found`);
    }
    return id;
  }
}
