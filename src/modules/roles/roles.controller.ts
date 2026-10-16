import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { Permission } from './permissions.js';
import { RolesService } from './roles.service.js';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto.js';

/** Everything needs roles:manage, except the lookup the user form uses (users:manage). */
@Controller('roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @RequirePermission(Permission.ROLES_MANAGE)
  list() {
    return this.rolesService.list();
  }

  // Declared before ':id' so these are not captured as an id.
  @Get('lookup')
  @RequirePermission(Permission.USERS_MANAGE)
  lookup() {
    return this.rolesService.lookup();
  }

  @Get('permissions')
  @RequirePermission(Permission.ROLES_MANAGE)
  permissions() {
    return this.rolesService.permissions();
  }

  @Get(':id')
  @RequirePermission(Permission.ROLES_MANAGE)
  findOne(@Param('id') id: string) {
    return this.rolesService.findOne(id);
  }

  @Post()
  @RequirePermission(Permission.ROLES_MANAGE)
  create(@Body() dto: CreateRoleDto, @CurrentUser() user: AuthenticatedUser) {
    return this.rolesService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission(Permission.ROLES_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentUser() user: AuthenticatedUser) {
    return this.rolesService.update(id, dto, user);
  }

  @Delete(':id')
  @RequirePermission(Permission.ROLES_MANAGE)
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.rolesService.remove(id, user);
  }
}
