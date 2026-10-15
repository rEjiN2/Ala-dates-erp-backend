import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { ProductGroupService } from './product-group.service.js';
import { CreateProductGroupDto } from './dto/create-product-group.dto.js';
import { UpdateProductGroupDto } from './dto/update-product-group.dto.js';
import { ProductGroupTreeQueryDto } from './dto/product-group-tree-query.dto.js';

@Controller('product-groups')
export class ProductGroupController {
  constructor(private readonly productGroupService: ProductGroupService) {}

  @Get()
  findAll() {
    return this.productGroupService.findAll();
  }

  @Get('tree')
  getTree(@Query() query: ProductGroupTreeQueryDto) {
    return this.productGroupService.getTree(query.rootId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productGroupService.findById(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('product-groups:manage')
  create(@Body() dto: CreateProductGroupDto) {
    return this.productGroupService.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('product-groups:manage')
  update(@Param('id') id: string, @Body() dto: UpdateProductGroupDto) {
    return this.productGroupService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('product-groups:manage')
  remove(@Param('id') id: string) {
    return this.productGroupService.remove(id);
  }
}
