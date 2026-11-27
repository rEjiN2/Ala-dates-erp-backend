import { OmitType, PickType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsInt, IsNumber, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { CreateProductDto, ProductQueryDto } from '../../../product/products/dto/product.dto.js';
import { ProductStatus } from '../../../product/products/schemas/product.schema.js';
import { ComposePartDto } from './bundling.dto.js';

/** Product fields reuse the product rules (name, group, unit, barcode, price, VAT, status). */
export class CreateBundleMasterDto extends PickType(CreateProductDto, [
  'name',
  'productGroupId',
  'unitId',
  'salePrice',
  'vatRate',
  'barcode',
  'status',
] as const) {
  /** Active stock products, unique, not bundles. */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ComposePartDto)
  parts: ComposePartDto[];

  /** Packing cost per bundle on top of the parts. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  defaultExtraCostPerUnit?: number;
}

/** Replaces the recipe; status has its own route. */
export class UpdateBundleMasterDto extends OmitType(CreateBundleMasterDto, ['status'] as const) {}

export class BundleMasterQueryDto extends PickType(ProductQueryDto, ['q', 'status', 'page'] as const) {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

export class BundleMasterStatusDto {
  @IsEnum(ProductStatus)
  status: ProductStatus;
}
