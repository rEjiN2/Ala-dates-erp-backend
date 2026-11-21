import { PickType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CancelVoucherDto, VoucherQueryDto } from '../../../accounting/vouchers/dto/voucher.dto.js';
import { BundlingMode } from '../schemas/bundling.schema.js';

export class RecipeComponentDto {
  /** A stock product (no bundles, not the bundle itself). */
  @IsMongoId()
  productId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  qty: number;
}

export class SetRecipeDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RecipeComponentDto)
  components: RecipeComponentDto[];

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  extraCostPerUnit: number;
}

export class CreateBundlingDto {
  /** Not in the future. */
  @IsDateString()
  date: string;

  /** An active warehouse, store or van. */
  @IsMongoId()
  locationId: string;

  @IsEnum(BundlingMode)
  mode: BundlingMode;

  /** Must have a recipe. */
  @IsMongoId()
  bundleProductId: string;

  @IsInt()
  @IsPositive()
  qty: number;

  /** Bundle mode only: set the bundle's purchase price to the computed cost. Default true. */
  @IsOptional()
  @IsBoolean()
  updateBundlePurchasePrice?: boolean;

  @IsOptional()
  @IsString()
  remarks?: string;
}

export class CancelBundlingDto extends CancelVoucherDto {}

export class ComposeNewProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  /** Default: the "Gift & Bundle Items" group. */
  @IsOptional()
  @IsMongoId()
  productGroupId?: string;

  @IsMongoId()
  unitId: string;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) salePrice?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) vatRate?: number;
  @IsOptional() @IsString() @MaxLength(50) barcode?: string;
}

/** Exactly one of `id` or `new`. */
export class ComposeProductDto {
  @IsOptional()
  @IsMongoId()
  id?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ComposeNewProductDto)
  new?: ComposeNewProductDto;
}

export class ComposePartDto {
  @IsMongoId()
  productId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  qtyPerBundle: number;
}

export class ComposeBundlingDto {
  @IsEnum(BundlingMode)
  mode: BundlingMode;

  @IsMongoId()
  locationId: string;

  @IsDateString()
  date: string;

  @IsOptional()
  @IsString()
  remarks?: string;

  /** 0 = save the product and recipe only. */
  @IsInt()
  @Min(0)
  qty: number;

  @ValidateNested()
  @Type(() => ComposeProductDto)
  product: ComposeProductDto;

  /** Omit to use the product's saved recipe. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ComposePartDto)
  parts?: ComposePartDto[];

  /** Default: the saved recipe's, else 0. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  extraCostPerUnit?: number;

  /** Save `parts` as the product's recipe. Always done for a new product. */
  @IsOptional()
  @IsBoolean()
  saveRecipe?: boolean;

  @IsOptional()
  @IsBoolean()
  updateBundlePurchasePrice?: boolean;
}

export class PreviewBundlingDto {
  @IsMongoId()
  locationId: string;

  @IsInt()
  @IsPositive()
  qty: number;

  /** Either `parts` (a new or edited bundle) or `productId` (its saved recipe). */
  @IsOptional()
  @IsMongoId()
  productId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ComposePartDto)
  parts?: ComposePartDto[];

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  extraCostPerUnit?: number;
}

export class BundlingQueryDto extends PickType(VoucherQueryDto, [
  'dateFrom',
  'dateTo',
  'status',
  'q',
  'page',
  'pageSize',
] as const) {
  @IsOptional()
  @IsMongoId()
  locationId?: string;

  @IsOptional()
  @IsMongoId()
  bundleProductId?: string;

  @IsOptional()
  @IsEnum(BundlingMode)
  mode?: BundlingMode;
}

export class AvailabilityQueryDto {
  @IsMongoId()
  locationId: string;

  /** Bundles to make; default 1. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  qty?: number;
}
