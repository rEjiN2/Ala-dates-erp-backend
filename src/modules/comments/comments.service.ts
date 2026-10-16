import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import { COMMENT_MAX_LENGTH, Comment, CommentDocument } from './schemas/comment.schema.js';
import { CreateCommentDto, EntityRefQueryDto } from './dto/comment.dto.js';
import { EntityAccessRegistry } from './entity-access.registry.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';

export interface CommentView {
  id: string;
  entityType: string;
  entityId: string;
  text: string;
  author: { id: string; name: string };
  createdAt: Date;
}

/** Create and read only: there is deliberately no update or delete, and the schema refuses them too. */
@Injectable()
export class CommentsService {
  constructor(
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
    private readonly entityAccess: EntityAccessRegistry,
  ) {}

  /** The author is always the authenticated user. */
  async create(dto: CreateCommentDto, user: AuthenticatedUser): Promise<CommentView> {
    const text = typeof dto.text === 'string' ? dto.text.trim() : '';
    if (text.length < 1 || text.length > COMMENT_MAX_LENGTH) {
      throw new BadRequestException(`Comment text must be 1 to ${COMMENT_MAX_LENGTH} characters`);
    }
    const entityId = await this.entityAccess.assertReadable(dto.entityType, dto.entityId, user);

    const created = await this.commentModel.create({
      entityType: dto.entityType,
      entityId,
      text,
      authorId: new Types.ObjectId(user.id),
      authorName: user.name,
      createdAt: new Date(),
    });
    return this.toView(created.toObject());
  }

  /** Newest first. */
  async list(query: EntityRefQueryDto, user: AuthenticatedUser): Promise<CommentView[]> {
    const entityId = await this.entityAccess.assertReadable(query.entityType, query.entityId, user);
    return this.findForEntity(query.entityType, entityId);
  }

  /** No access check: callers have already authorised the entity. */
  async findForEntity(entityType: string, entityId: Types.ObjectId): Promise<CommentView[]> {
    const comments = await this.commentModel
      .find({ entityType, entityId })
      .sort({ createdAt: -1, _id: -1 })
      .lean<(Comment & { _id: Types.ObjectId })[]>()
      .exec();
    return comments.map((comment) => this.toView(comment));
  }

  /** Comment count per entity id, for list screens. Ids with no comments are absent. */
  async countByEntityIds(entityType: string, entityIds: readonly Types.ObjectId[]): Promise<Map<string, number>> {
    if (entityIds.length === 0) {
      return new Map();
    }
    const rows = await this.commentModel
      .aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { entityType, entityId: { $in: entityIds } } },
        { $group: { _id: '$entityId', count: { $sum: 1 } } },
      ])
      .exec();
    return new Map(rows.map((row) => [row._id.toString(), row.count]));
  }

  private toView(comment: Comment & { _id: Types.ObjectId }): CommentView {
    return {
      id: comment._id.toString(),
      entityType: comment.entityType,
      entityId: comment.entityId.toString(),
      text: comment.text,
      author: { id: comment.authorId.toString(), name: comment.authorName },
      createdAt: comment.createdAt,
    };
  }
}
