import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { CommentsService } from './comments.service.js';
import { ActivityService } from './activity.service.js';
import { CreateCommentDto, EntityRefQueryDto } from './dto/comment.dto.js';

/**
 * Any logged-in user who can read the entity may read and add comments; the
 * per-entity read rule comes from EntityAccessRegistry. No PATCH or DELETE:
 * comments are append-only.
 */
@Controller('comments')
@UseGuards(JwtAuthGuard)
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Get()
  list(@Query() query: EntityRefQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.commentsService.list(query, user);
  }

  @Post()
  create(@Body() dto: CreateCommentDto, @CurrentUser() user: AuthenticatedUser) {
    return this.commentsService.create(dto, user);
  }
}

@Controller('activity')
@UseGuards(JwtAuthGuard)
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get()
  timeline(@Query() query: EntityRefQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.activityService.timeline(query, user);
  }
}
