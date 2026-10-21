import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/interfaces/auth.types.js';
import { Permission } from '../roles/permissions.js';
import { UsersService } from './users.service.js';
import { UserManagementService } from './user-management.service.js';
import { CreateUserDto, ResetPasswordDto, UpdateUserDto, UserLookupQueryDto, UserQueryDto } from './dto/user.dto.js';

/** The lookup is open to any logged-in user; everything else needs users:manage. */
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly userManagement: UserManagementService,
  ) {}

  /**
   * id + name of every user, for "Created by" style filters. With ?for=receipt|payment:
   * the users who can be Collected By / Paid By (only yourself without vouchers:select-collector).
   */
  @Get('lookup')
  lookup(@Query() query: UserLookupQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return query.for ? this.usersService.collectorLookup(query.for, user) : this.usersService.lookup();
  }

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.USERS_MANAGE)
  list(@Query() query: UserQueryDto) {
    return this.userManagement.list(query);
  }

  @Get(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.USERS_MANAGE)
  findOne(@Param('id') id: string) {
    return this.userManagement.findOne(id);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.USERS_MANAGE)
  create(@Body() dto: CreateUserDto, @CurrentUser() user: AuthenticatedUser) {
    return this.userManagement.create(dto, user);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.USERS_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthenticatedUser) {
    return this.userManagement.update(id, dto, user);
  }

  @Post(':id/deactivate')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.USERS_MANAGE)
  deactivate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.userManagement.deactivate(id, user);
  }

  /** Sets a temporary password; the user must change it at their next login. */
  @Post(':id/reset-password')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.USERS_MANAGE)
  resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto, @CurrentUser() user: AuthenticatedUser) {
    return this.userManagement.resetPassword(id, dto, user);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.USERS_MANAGE)
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.userManagement.remove(id, user);
  }
}
