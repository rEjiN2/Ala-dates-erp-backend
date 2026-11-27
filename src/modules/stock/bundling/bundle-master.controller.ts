import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission, hasPermission } from '../../roles/permissions.js';
import { BundleMasterService } from './bundle-master.service.js';
import {
  BundleMasterQueryDto,
  BundleMasterStatusDto,
  CreateBundleMasterDto,
  UpdateBundleMasterDto,
} from './dto/bundle-master.dto.js';

/** Bundle master: writes need bundles:manage; reads need bundles:read or bundling:read. */
@Controller('bundle-masters')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BundleMasterController {
  constructor(private readonly service: BundleMasterService) {}

  @Get()
  findAll(@Query() query: BundleMasterQueryDto, @CurrentUser() user: AuthenticatedUser) {
    assertCanRead(user);
    return this.service.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    assertCanRead(user);
    return this.service.findById(id);
  }

  @Post()
  @RequirePermission(Permission.BUNDLES_MANAGE)
  create(@Body() dto: CreateBundleMasterDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.create(dto, user);
  }

  @Put(':id')
  @RequirePermission(Permission.BUNDLES_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateBundleMasterDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.update(id, dto, user);
  }

  @Patch(':id/status')
  @RequirePermission(Permission.BUNDLES_MANAGE)
  setStatus(@Param('id') id: string, @Body() dto: BundleMasterStatusDto, @CurrentUser() user: AuthenticatedUser) {
    return this.service.setStatus(id, dto, user);
  }
}

function assertCanRead(user: AuthenticatedUser): void {
  if (!hasPermission(user, Permission.BUNDLES_READ) && !hasPermission(user, Permission.BUNDLING_READ)) {
    throw new ForbiddenException('Insufficient permissions');
  }
}
