import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { LocationService } from './location.service.js';
import { CreateLocationDto } from './dto/create-location.dto.js';
import { UpdateLocationDto } from './dto/update-location.dto.js';
import { LocationTreeQueryDto } from './dto/location-tree-query.dto.js';

@Controller('locations')
@UseGuards(JwtAuthGuard)
export class LocationController {
  constructor(private readonly locationService: LocationService) {}

  @Get()
  findAll() {
    return this.locationService.findAll();
  }

  @Get('tree')
  getTree(@Query() query: LocationTreeQueryDto) {
    return this.locationService.getTree(query.rootId);
  }

  // Declared before ':id' so "rules" is not captured as an id. The frontend
  // reads the hierarchy from here instead of hardcoding it.
  @Get('rules')
  getRules() {
    return this.locationService.getRules();
  }

  @Get(':id/descendants')
  getDescendants(@Param('id') id: string) {
    return this.locationService.getDescendants(id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.locationService.findById(id);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermission('locations:manage')
  create(@Body() dto: CreateLocationDto) {
    return this.locationService.create(dto);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission('locations:manage')
  update(@Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.locationService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission('locations:manage')
  remove(@Param('id') id: string) {
    return this.locationService.remove(id);
  }
}
