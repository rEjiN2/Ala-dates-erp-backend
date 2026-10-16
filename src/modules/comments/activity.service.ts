import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuditAction, AuditChange } from '../audit/schemas/audit-log.schema.js';
import { CommentsService, type CommentView } from './comments.service.js';
import { EntityAccessRegistry } from './entity-access.registry.js';
import type { EntityRefQueryDto } from './dto/comment.dto.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

export type ActivityItem =
  | {
      kind: 'audit';
      id: string;
      at: Date;
      actor: { id: string; name: string };
      action: AuditAction;
      entityRef: string | null;
      changes: AuditChange[];
      reason: string | null;
    }
  | ({ kind: 'comment'; at: Date } & CommentView);

export interface ActivityTimeline {
  items: ActivityItem[];
  commentCount: number;
}

@Injectable()
export class ActivityService {
  constructor(
    private readonly auditService: AuditService,
    private readonly commentsService: CommentsService,
    private readonly entityAccess: EntityAccessRegistry,
  ) {}

  /** Audit entries and comments for one record, merged newest first. */
  async timeline(query: EntityRefQueryDto, user: AuthenticatedUser): Promise<ActivityTimeline> {
    const entityId = await this.entityAccess.assertReadable(query.entityType, query.entityId, user);

    const [auditEntries, comments] = await Promise.all([
      this.auditService.findForEntity(query.entityType, entityId),
      this.commentsService.findForEntity(query.entityType, entityId),
    ]);

    const items: ActivityItem[] = [
      ...auditEntries.map((entry): ActivityItem => ({
        kind: 'audit',
        id: entry._id.toString(),
        at: entry.at,
        actor: { id: entry.actorId.toString(), name: entry.actorName },
        action: entry.action,
        entityRef: entry.entityRef ?? null,
        changes: entry.changes,
        reason: entry.reason ?? null,
      })),
      ...comments.map((comment): ActivityItem => ({
        kind: 'comment',
        at: comment.createdAt,
        ...comment,
      })),
    ];
    // Stable sort: on an exact timestamp tie the audit entry (listed first) stays ahead.
    items.sort((a, b) => b.at.getTime() - a.at.getTime());

    return { items, commentCount: comments.length };
  }
}
