import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Comment, CommentSchema } from './schemas/comment.schema.js';
import { CommentsService } from './comments.service.js';
import { ActivityService } from './activity.service.js';
import { EntityAccessRegistry } from './entity-access.registry.js';
import { ActivityController, CommentsController } from './comments.controller.js';
import { AuditModule } from '../audit/audit.module.js';

/**
 * Reusable comments plus the merged activity timeline (audit + comments).
 * An entity module opts in by importing this and registering its type with
 * EntityAccessRegistry.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: Comment.name, schema: CommentSchema }]), AuditModule],
  controllers: [CommentsController, ActivityController],
  providers: [CommentsService, ActivityService, EntityAccessRegistry],
  exports: [CommentsService, EntityAccessRegistry],
})
export class CommentsModule {}
