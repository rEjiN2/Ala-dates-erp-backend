import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from '../../../common/guards/permissions.guard.js';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/auth.types.js';
import { Permission, hasPermission } from '../../roles/permissions.js';
import { ProductService, type ProductView } from './product.service.js';
import { CreateProductDto, ProductLookupQueryDto, ProductQueryDto, UpdateProductDto } from './dto/product.dto.js';

/** Products. Reads for any logged-in user; writes need products:manage; purchasePrice only with products:view-cost. */
@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  async list(@Query() query: ProductQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const page = await this.productService.list(query);
    return { ...page, items: page.items.map((product) => this.forUser(product, user)) };
  }

  // Declared before ':id' so "lookup" is not captured as an id.
  /** Active products: id, code, name, unit, salePrice, vatRate. Never cost. */
  @Get('lookup')
  lookup(@Query() query: ProductLookupQueryDto) {
    return this.productService.lookup(query);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.forUser(await this.productService.findById(id), user);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.PRODUCTS_MANAGE)
  async create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthenticatedUser) {
    return this.forUser(await this.productService.create(dto, user), user);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.PRODUCTS_MANAGE)
  async update(@Param('id') id: string, @Body() dto: UpdateProductDto, @CurrentUser() user: AuthenticatedUser) {
    return this.forUser(await this.productService.update(id, dto, user), user);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.PRODUCTS_MANAGE)
  remove(@Param('id') id: string) {
    return this.productService.remove(id);
  }

  /** multipart/form-data: `file` (an image). Replaces any previous image. */
  @Post(':id/image')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.PRODUCTS_MANAGE)
  @UseInterceptors(FileInterceptor('file'))
  async setImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.forUser(await this.productService.setImage(id, file, user), user);
  }

  @Delete(':id/image')
  @UseGuards(PermissionsGuard)
  @RequirePermission(Permission.PRODUCTS_MANAGE)
  async removeImage(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.forUser(await this.productService.removeImage(id, user), user);
  }

  private forUser(product: ProductView, user: AuthenticatedUser): ProductView {
    if (hasPermission(user, Permission.PRODUCTS_VIEW_COST)) return product;
    const { purchasePrice: _purchasePrice, ...rest } = product;
    return rest;
  }
}
