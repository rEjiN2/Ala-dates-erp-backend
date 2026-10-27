import { Body, Controller, Get, Header, Param, Post, Put, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission } from '../../roles/permissions.js';
import { BundlingService } from './bundling.service.js';
import {
  AvailabilityQueryDto,
  BundlingQueryDto,
  CancelBundlingDto,
  CreateBundlingDto,
  SetRecipeDto,
} from './dto/bundling.dto.js';

/** Recipes: PUT needs bundles:manage; reads need bundling:read. The actor always comes from the token. */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BundlingController {
  constructor(private readonly bundlingService: BundlingService) {}

  @Get('products/:id/recipe')
  @RequirePermission(Permission.BUNDLING_READ)
  getRecipe(@Param('id') id: string) {
    return this.bundlingService.getRecipe(id);
  }

  @Put('products/:id/recipe')
  @RequirePermission(Permission.BUNDLES_MANAGE)
  setRecipe(@Param('id') id: string, @Body() dto: SetRecipeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.bundlingService.setRecipe(id, dto, user);
  }

  @Get('bundles/:productId/availability')
  @RequirePermission(Permission.BUNDLING_READ)
  availability(
    @Param('productId') productId: string,
    @Query() query: AvailabilityQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bundlingService.availability(productId, query, user);
  }

  @Get('bundlings')
  @RequirePermission(Permission.BUNDLING_READ)
  findAll(@Query() query: BundlingQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.bundlingService.findAll(query, user);
  }

  @Get('bundlings/:id')
  @RequirePermission(Permission.BUNDLING_READ)
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bundlingService.findById(id, user);
  }

  /** BUNDLING NOTE as an A4 PDF. Every call is a print: it is audited. */
  @Get('bundlings/:id/pdf')
  @RequirePermission(Permission.BUNDLING_READ)
  @Header('Cache-Control', 'private, no-store')
  async pdf(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const printed = await this.bundlingService.pdf(id, user);
    return new StreamableFile(printed.buffer, {
      type: 'application/pdf',
      length: printed.buffer.length,
      disposition: `inline; filename="${printed.filename}"`,
    });
  }

  @Post('bundlings')
  @RequirePermission(Permission.BUNDLING_CREATE)
  create(@Body() dto: CreateBundlingDto, @CurrentUser() user: AuthenticatedUser) {
    return this.bundlingService.create(dto, user);
  }

  @Post('bundlings/:id/cancel')
  @RequirePermission(Permission.BUNDLING_CANCEL)
  cancel(@Param('id') id: string, @Body() dto: CancelBundlingDto, @CurrentUser() user: AuthenticatedUser) {
    return this.bundlingService.cancel(id, dto, user);
  }
}
