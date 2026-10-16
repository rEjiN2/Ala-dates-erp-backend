import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Model } from 'mongoose';
import { AuditAction, AuditChange, AuditLog, AuditLogDocument } from './schemas/audit-log.schema.js';
import type { Actor } from '../../common/schemas/user-snapshot.schema.js';

export interface AuditEntryInput {
  entityType: string;
  entityId: string | Types.ObjectId;
  entityRef?: string;
  action: AuditAction;
  /** The authenticated user. Never take this from a request body. */
  actor: Actor;
  changes?: AuditChange[];
  reason?: string;
  /** Defaults to now; pass the business change's own timestamp so both match exactly. */
  at?: Date;
}

export type AuditLogRecord = AuditLog & { _id: Types.ObjectId };

/**
 * Write side is `record` only: there is deliberately no update or delete,
 * and the schema refuses them too.
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditLog.name)
    private readonly auditLogModel: Model<AuditLogDocument>,
  ) {}

  /**
   * Writes the entry on the caller's transaction session. Refuses to run
   * outside a transaction: an audit entry written separately from its business
   * change could survive that change rolling back.
   */
  async record(entry: AuditEntryInput, session: ClientSession): Promise<AuditLogDocument> {
    if (!session?.inTransaction()) {
      throw new Error("AuditService.record must be called inside the business change's transaction");
    }

    const reason = entry.reason?.trim();
    const [created] = await this.auditLogModel.create(
      [
        {
          entityType: entry.entityType,
          entityId: new Types.ObjectId(entry.entityId),
          entityRef: entry.entityRef,
          action: entry.action,
          actorId: new Types.ObjectId(entry.actor.id),
          actorName: entry.actor.name,
          at: entry.at ?? new Date(),
          changes: entry.changes ?? [],
          reason: reason || undefined,
        },
      ],
      { session },
    );
    return created;
  }

  /** Whether this user performed any audited action, i.e. has history that must keep pointing at them. */
  async hasActor(actorId: Types.ObjectId, session?: ClientSession): Promise<boolean> {
    return Boolean(
      await this.auditLogModel
        .exists({ actorId })
        .session(session ?? null)
        .exec(),
    );
  }

  /** Newest first. */
  async findForEntity(entityType: string, entityId: Types.ObjectId): Promise<AuditLogRecord[]> {
    return this.auditLogModel.find({ entityType, entityId }).sort({ at: -1, _id: -1 }).lean<AuditLogRecord[]>().exec();
  }
}
