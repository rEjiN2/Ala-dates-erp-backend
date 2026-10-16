import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { insertOnlyPlugin } from '../../../common/utils/insert-only.plugin.js';

export type CommentDocument = HydratedDocument<Comment>;

export const COMMENT_MAX_LENGTH = 1000;

/** Free-text note on any registered entity. Append-only: comments are never edited or removed. */
@Schema({ collection: 'comments', versionKey: false })
export class Comment {
  @Prop({ required: true, trim: true })
  entityType: string;

  @Prop({ type: Types.ObjectId, required: true })
  entityId: Types.ObjectId;

  @Prop({
    required: true,
    trim: true,
    minlength: 1,
    maxlength: COMMENT_MAX_LENGTH,
  })
  text: string;

  @Prop({ type: Types.ObjectId, required: true })
  authorId: Types.ObjectId;

  /** Snapshot of the author's name when the comment was posted. */
  @Prop({ required: true, trim: true })
  authorName: string;

  @Prop({ required: true })
  createdAt: Date;
}

export const CommentSchema = SchemaFactory.createForClass(Comment);

CommentSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
CommentSchema.plugin(insertOnlyPlugin, { modelName: Comment.name });
