import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { Permission } from '../../roles/permissions.js';
import { UnitService } from './unit.service.js';
import { CreateUnitDto, UpdateUnitDto } from './dto/unit.dto.js';

/** Units of measure. Reads for any logged-in user; writes need units:manage. */
@Controller('units')
@UseGuards(JwtAuthGuard)
export class UnitController {
  constructor(private readonly unitService: UnitService) {}

  @Get()
  findAll() {
    return this.unitService.findAll();
  }

  // Declared before ':id' so "lookup" is not captured as an id.
  @Get('lookup')
  lookup() {
    return this.unitService.lookup();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.unitService.findById(id);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.UNITS_MANAGE)
  create(@Body() dto: CreateUnitDto) {
    return this.unitService.create(dto);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.UNITS_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateUnitDto) {
    return this.unitService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.UNITS_MANAGE)
  remove(@Param('id') id: string) {
    return this.unitService.remove(id);
  }
}
